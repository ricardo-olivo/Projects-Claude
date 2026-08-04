$port = 8765
$dir  = $PSScriptRoot

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Servidor rodando em http://localhost:$port/"

while ($listener.IsListening) {
    $ctx  = $listener.GetContext()
    $path = $ctx.Request.Url.LocalPath.TrimStart('/')
    if (!$path -or $path -eq '') { $path = 'Dashboard.html' }
    $file = Join-Path $dir $path
    if (Test-Path $file) {
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $ctx.Response.ContentType = 'text/html; charset=utf-8'
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
}
