$port = 9231
$dir  = $PSScriptRoot
$sheetId = "1C6xsW-0ipDh9nv9eAW_y9DZGOEEY5j9g"
$csvUrl = "https://docs.google.com/spreadsheets/d/$sheetId/gviz/tq?tqx=out:csv"
$dataPath = Join-Path $dir "data.json"

function ConvertFrom-BRLNumber {
    param([string]$s)
    if ([string]::IsNullOrWhiteSpace($s)) { return 0.0 }
    $t = $s.Trim()
    $neg = $false
    if ($t.StartsWith("-")) { $neg = $true; $t = $t.Substring(1) }
    $t = $t -replace 'R\$', ''
    $t = $t -replace '%', ''
    $t = $t.Trim()
    if ($t.StartsWith("-")) { $neg = $true; $t = $t.Substring(1) }
    $t = $t -replace '\.', ''
    $t = $t -replace ',', '.'
    if ($t -eq '') { return 0.0 }
    $v = [double]::Parse($t, [System.Globalization.CultureInfo]::InvariantCulture)
    if ($neg) { return -$v } else { return $v }
}

function Get-FreshDashboardData {
    $resp = Invoke-WebRequest -Uri $csvUrl -UseBasicParsing
    $content = $resp.Content

    $lines = $content -split "`r?`n" | Where-Object { $_ -ne "" }
    $headers = 1..26 | ForEach-Object { "c$_" }
    $rows = $lines | Select-Object -Skip 1 | ConvertFrom-Csv -Header $headers

    $months = New-Object System.Collections.ArrayList
    $cur = $null
    foreach ($r in $rows) {
        $mes = $r.c1.Trim()
        $porte = $r.c2.Trim()
        $filial = $r.c3.Trim()

        if ($mes -ne "" -and $mes -ne "Mês") {
            $cur = [ordered]@{ mes = $mes; despesaCentral = 0.0; vencimento = 0.0; stores = New-Object System.Collections.ArrayList }
            [void]$months.Add($cur)
        }
        if ($null -eq $cur) { continue }

        if ($filial -eq "VENDA TOTAL" -or $filial -eq "" -or $filial -eq "Filial") { continue }
        elseif ($filial -eq "DESPESAS CENTRAL") { $cur.despesaCentral = ConvertFrom-BRLNumber $r.c4 }
        elseif ($filial -eq "DESP. CENTRAL + VENC.") { continue }
        elseif ($filial -eq "VENCIMENTO") { $cur.vencimento = ConvertFrom-BRLNumber $r.c4 }
        elseif ($porte -ne "") {
            [void]$cur.stores.Add([ordered]@{
                porte = $porte
                filial = $filial
                faturamento = ConvertFrom-BRLNumber $r.c4
                margemTrier = ConvertFrom-BRLNumber $r.c8
                margemManipulado = ConvertFrom-BRLNumber $r.c10
                despesa = ConvertFrom-BRLNumber $r.c11
                manipulados = ConvertFrom-BRLNumber $r.c12
                resultadoBruto = ConvertFrom-BRLNumber $r.c14
            })
        }
    }

    if ($months.Count -eq 0) { throw "Nenhum mes encontrado na planilha, verifique o formato." }

    $payload = [ordered]@{
        updatedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
        months = $months
    }
    return $payload
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Servidor rodando em http://localhost:$port/"

while ($listener.IsListening) {
    $ctx  = $listener.GetContext()
    $req  = $ctx.Request
    $path = $req.Url.LocalPath.TrimStart('/')

    if ($req.HttpMethod -eq "POST" -and $path -eq "refresh") {
        try {
            $payload = Get-FreshDashboardData
            $json = $payload | ConvertTo-Json -Depth 6 -Compress
            [System.IO.File]::WriteAllText($dataPath, $json, [System.Text.Encoding]::UTF8)
            $respBody = '{"ok":true,"updatedAt":"' + $payload.updatedAt + '"}'
            $ctx.Response.StatusCode = 200
            $ctx.Response.ContentType = 'application/json; charset=utf-8'
            $outBytes = [System.Text.Encoding]::UTF8.GetBytes($respBody)
            $ctx.Response.OutputStream.Write($outBytes, 0, $outBytes.Length)
        } catch {
            $msg = $_.Exception.Message -replace '"', "'"
            $respBody = '{"ok":false,"error":"' + $msg + '"}'
            $ctx.Response.StatusCode = 500
            $ctx.Response.ContentType = 'application/json; charset=utf-8'
            $outBytes = [System.Text.Encoding]::UTF8.GetBytes($respBody)
            $ctx.Response.OutputStream.Write($outBytes, 0, $outBytes.Length)
        }
        $ctx.Response.Close()
        continue
    }

    if (!$path -or $path -eq '') { $path = 'index.html' }
    $file = Join-Path $dir $path
    if (Test-Path $file) {
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $ext = [System.IO.Path]::GetExtension($file)
        $ctx.Response.ContentType = if ($ext -eq '.json') { 'application/json; charset=utf-8' } else { 'text/html; charset=utf-8' }
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
}
