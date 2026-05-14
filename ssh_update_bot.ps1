$password = "kienkaka2001"
$user = "ubuntu"
$ip = "57.129.134.155"

function Get-Base64($path) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    return [Convert]::ToBase64String($bytes)
}

$fileContent = Get-Base64("c:\Users\phanh\Documents\Livenew\telegramBot.js")

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
$p.StandardInput.WriteLine("base64 -d > telegramBot.js << 'EOF'")
$p.StandardInput.WriteLine($fileContent)
$p.StandardInput.WriteLine("EOF")
Start-Sleep -Seconds 2

$p.StandardInput.WriteLine("pm2 restart live-controller")
$p.StandardInput.WriteLine("exit")

$p.WaitForExit()
Write-Output "Update telegramBot.js complete!"
