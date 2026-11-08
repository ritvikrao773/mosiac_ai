$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$port = 8765
$meshKey = [Environment]::GetEnvironmentVariable('MESH_API_KEY')
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")

function Send-Response($response, [int]$status, [string]$contentType, [string]$body) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $response.StatusCode = $status
  $response.ContentType = $contentType
  $response.ContentEncoding = [System.Text.Encoding]::UTF8
  $response.Headers['Cache-Control'] = 'no-store'
  $response.Headers['X-Content-Type-Options'] = 'nosniff'
  $response.ContentLength64 = $bytes.Length
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.Close()
}

function Invoke-MeshJson([string]$path, [string]$method, $body = $null) {
  $request = [System.Net.HttpWebRequest]::Create("https://api.meshapi.ai$path")
  $request.Method = $method
  $request.Headers.Add('Authorization', "Bearer $meshKey")
  $request.Timeout = 90000
  $request.ReadWriteTimeout = 90000
  if ($null -ne $body) {
    $request.ContentType = 'application/json'
    $jsonBody = $body | ConvertTo-Json -Depth 12 -Compress
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($jsonBody)
    $request.ContentLength = $bodyBytes.Length
    $stream = $request.GetRequestStream()
    $stream.Write($bodyBytes, 0, $bodyBytes.Length)
    $stream.Close()
  }
  try {
    $webResponse = $request.GetResponse()
  } catch [System.Net.WebException] {
    $errorResponse = $_.Exception.Response
    if ($null -eq $errorResponse) { throw }
    $reader = New-Object System.IO.StreamReader($errorResponse.GetResponseStream())
    $errorText = $reader.ReadToEnd()
    $reader.Close()
    $statusCode = [int]$errorResponse.StatusCode
    $errorResponse.Close()
    try {
      $parsed = $errorText | ConvertFrom-Json
      $message = $parsed.error.message
      if (-not $message) { $message = $parsed.message }
    } catch { $message = $null }
    if (-not $message) { $message = "Mesh API request failed ($statusCode)." }
    throw $message
  }
  $responseReader = New-Object System.IO.StreamReader($webResponse.GetResponseStream())
  $responseText = $responseReader.ReadToEnd()
  $responseReader.Close()
  $webResponse.Close()
  return ($responseText | ConvertFrom-Json)
}

Write-Host "Mosaic local preview: http://localhost:$port"
if ($meshKey) { Write-Host 'Mesh API key found. Available models and chat will use your Mesh account.' }
else { Write-Host 'Demo mode: add MESH_API_KEY to .env.local to enable live Mesh models and chat.' }
$listener.Start()
try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    $path = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)

    if ($request.HttpMethod -eq 'GET' -and $path -eq '/api/config') {
      $config = @{ configured = [bool]$meshKey; previewMode = $true; appName = 'Mosaic AI local preview' } | ConvertTo-Json -Compress
      Send-Response $response 200 'application/json; charset=utf-8' $config
      continue
    }

    if ($request.HttpMethod -eq 'GET' -and $path -eq '/api/models') {
      if ($meshKey) {
        try {
          $result = Invoke-MeshJson '/v1/models' 'GET'
          $catalog = $result
          if ($result -is [System.Collections.IDictionary] -and $result.Contains('data')) { $catalog = $result.data }
          $textModels = @($catalog | Where-Object { $_.id -and ($_.model_type -eq 'text' -or $_.input_modalities -contains 'text') } | ForEach-Object {
            @{ id = $_.id; name = $(if ($_.name) { $_.name } else { $_.id }); brand = $_.brand; is_free = [bool]$_.is_free; model_type = 'text' }
          })
          $json = @{ models = $textModels } | ConvertTo-Json -Depth 6 -Compress
          Send-Response $response 200 'application/json; charset=utf-8' $json
        } catch {
          $json = @{ error = [string]$_.Exception.Message } | ConvertTo-Json -Compress
          Send-Response $response 502 'application/json; charset=utf-8' $json
        }
      } else {
        $models = @(
          @{ id = 'openai/gpt-4o-mini'; name = 'GPT-4o mini (demo)'; brand = 'OpenAI'; is_free = $false; model_type = 'text' },
          @{ id = 'google/gemini-2.5-flash'; name = 'Gemini 2.5 Flash (demo)'; brand = 'Google'; is_free = $false; model_type = 'text' },
          @{ id = 'anthropic/claude-sonnet'; name = 'Claude Sonnet (demo)'; brand = 'Anthropic'; is_free = $false; model_type = 'text' }
        )
        $json = @{ models = $models } | ConvertTo-Json -Depth 5 -Compress
        Send-Response $response 200 'application/json; charset=utf-8' $json
      }
      continue
    }

    if ($request.HttpMethod -eq 'POST' -and $path -eq '/api/chat') {
      try {
        $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
        $payload = $reader.ReadToEnd() | ConvertFrom-Json
        $reader.Close()
        if (-not $meshKey) {
          $lastUser = @($payload.messages | Where-Object { $_.role -eq 'user' } | Select-Object -Last 1)
          if ($lastUser.Count -eq 0 -or -not $lastUser[0].content) {
            Send-Response $response 400 'application/json; charset=utf-8' '{"error":"Enter a message to try the preview."}'
            continue
          }
          $prompt = [string]$lastUser[0].content
          if ($prompt.Length -gt 400) { $prompt = $prompt.Substring(0, 400) + '...' }
          $reply = "Local demo only - not a live AI answer. Your message was: `"$prompt`". Add MESH_API_KEY to .env.local to use real models."
          $json = @{ reply = $reply; usage = $null } | ConvertTo-Json -Depth 3 -Compress
          Send-Response $response 200 'application/json; charset=utf-8' $json
          continue
        }
        $modelId = [string]$payload.model
        $messages = @($payload.messages | ForEach-Object { @{ role = $_.role; content = $_.content } })
        if (-not $modelId -or $messages.Count -eq 0 -or $messages.Count -gt 50) {
          Send-Response $response 400 'application/json; charset=utf-8' '{"error":"Choose a model and enter a valid chat message."}'
          continue
        }
        $chatBody = @{ model = $modelId; messages = @(@{ role = 'system'; content = 'You are a helpful, clear, and friendly AI assistant.' }) + $messages }
        $result = Invoke-MeshJson '/v1/chat/completions' 'POST' $chatBody
        $reply = $result.choices[0].message.content
        if ($reply -is [array]) { $reply = ($reply | ForEach-Object { $_.text }) -join "`n" }
        $json = @{ reply = [string]$reply; usage = $result.usage } | ConvertTo-Json -Depth 8 -Compress
        Send-Response $response 200 'application/json; charset=utf-8' $json
      } catch {
        $json = @{ error = [string]$_.Exception.Message } | ConvertTo-Json -Compress
        Send-Response $response 502 'application/json; charset=utf-8' $json
      }
      continue
    }

    if ($request.HttpMethod -ne 'GET' -and $request.HttpMethod -ne 'HEAD') {
      Send-Response $response 405 'application/json; charset=utf-8' '{"error":"Method not allowed."}'
      continue
    }

    if ($path -eq '/') { $path = '/index.html' }
    $relative = $path.TrimStart('/') -replace '/', [System.IO.Path]::DirectorySeparatorChar
    $file = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $relative))
    if (-not $file.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
      Send-Response $response 403 'text/plain; charset=utf-8' 'Forbidden'
      continue
    }
    if (-not [System.IO.File]::Exists($file)) {
      Send-Response $response 404 'text/plain; charset=utf-8' 'Not found'
      continue
    }
    $extension = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
    $mime = switch ($extension) {
      '.html' { 'text/html; charset=utf-8' }
      '.css' { 'text/css; charset=utf-8' }
      '.js' { 'text/javascript; charset=utf-8' }
      '.json' { 'application/json; charset=utf-8' }
      '.svg' { 'image/svg+xml' }
      default { 'application/octet-stream' }
    }
    if ($request.HttpMethod -eq 'HEAD') {
      $response.StatusCode = 200
      $response.ContentType = $mime
      $response.Close()
    } else {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $response.StatusCode = 200
      $response.ContentType = $mime
      $response.Headers['X-Content-Type-Options'] = 'nosniff'
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
      $response.Close()
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
