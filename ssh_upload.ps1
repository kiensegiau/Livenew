$password = "95bAA8eMfkCV"
$user = "ubuntu"
$ip = "57.129.134.155"

function Get-Base64($path) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    return [Convert]::ToBase64String($bytes)
}

$files = @(
    @{ name = "server.js"; content = Get-Base64("c:\Users\phanh\Documents\Livenew\server.js") },
    @{ name = "telegramBot.js"; content = Get-Base64("c:\Users\phanh\Documents\Livenew\telegramBot.js") },
    @{ name = "driveDownloader.js"; content = Get-Base64("c:\Users\phanh\Documents\Livenew\driveDownloader.js") },
    @{ name = "videoMaker.js"; content = Get-Base64("c:\Users\phanh\Documents\Livenew\videoMaker.js") },
    @{ name = "package.json"; content = Get-Base64("c:\Users\phanh\Documents\Livenew\package.json") },
    @{ name = "bot_config.json"; content = Get-Base64("c:\Users\phanh\Documents\Livenew\bot_config.json") }
)

$si = New-Object System.Diagnostics.ProcessStartInfo
$si.FileName = "ssh"
$si.Arguments = "-o StrictHostKeyChecking=no $user@$ip"
$si.RedirectStandardInput = $true
$si.UseShellExecute = $false

$p = [System.Diagnostics.Process]::Start($si)
Start-Sleep -Seconds 5
$p.StandardInput.WriteLine($password)
Start-Sleep -Seconds 5

$p.StandardInput.WriteLine("cd ~/Livenew")

foreach ($file in $files) {
    Write-Output "Uploading $($file.name)..."
    $p.StandardInput.WriteLine("base64 -d > $($file.name) << 'EOF'")
    $p.StandardInput.WriteLine($file.content)
    $p.StandardInput.WriteLine("EOF")
    Start-Sleep -Seconds 2
}

$p.StandardInput.WriteLine("npm install")
Start-Sleep -Seconds 15
$p.StandardInput.WriteLine("pm2 delete live-controller 2>/dev/null")
$p.StandardInput.WriteLine("pm2 start server.js --name live-controller")
$p.StandardInput.WriteLine("pm2 save")
$p.StandardInput.WriteLine("exit")

$p.WaitForExit()
Write-Output "Setup complete! Bot is now running on VPS."
