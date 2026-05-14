$password = "kienkaka2001"
$user = "ubuntu"
$ip = "57.129.134.155"
$gitRepo = "https://github.com/kiensegiau/Livenew.git"

$si = New-Object System.Diagnostics.ProcessStartInfo
$si.FileName = "ssh"
$si.Arguments = "-o StrictHostKeyChecking=no $user@$ip"
$si.RedirectStandardInput = $true
$si.UseShellExecute = $false

$p = [System.Diagnostics.Process]::Start($si)
Start-Sleep -Seconds 5
$p.StandardInput.WriteLine($password)
Start-Sleep -Seconds 5

# Cài đặt môi trường Robust
$p.StandardInput.WriteLine("export DEBIAN_FRONTEND=noninteractive")
$p.StandardInput.WriteLine("sudo apt-get update")
$p.StandardInput.WriteLine($password)
Start-Sleep -Seconds 10
$p.StandardInput.WriteLine("sudo apt-get -y -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' install nodejs npm ffmpeg git")
Start-Sleep -Seconds 45
$p.StandardInput.WriteLine("sudo npm install pm2 -g")
Start-Sleep -Seconds 15

# Clone và setup code
$p.StandardInput.WriteLine("rm -rf ~/Livenew")
$p.StandardInput.WriteLine("git clone $gitRepo ~/Livenew")
Start-Sleep -Seconds 10
$p.StandardInput.WriteLine("cd ~/Livenew && npm install")
Start-Sleep -Seconds 15

# Tạo file config
$botConfig = @"
{
  "token": "7980487406:AAELoFEy9ayIQVgWEugEPG6x0VIclBJ0uTA",
  "adminIds": [
    1663554465
  ],
  "password": "kienkaka"
}
"@
$configBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($botConfig))
$p.StandardInput.WriteLine("echo '$configBase64' | base64 -d > bot_config.json")
Start-Sleep -Seconds 2

# Chạy PM2
$p.StandardInput.WriteLine("pm2 delete live-controller 2>/dev/null")
$p.StandardInput.WriteLine("pm2 start server.js --name live-controller")
$p.StandardInput.WriteLine("pm2 save")
$p.StandardInput.WriteLine("exit")

$p.WaitForExit()
Write-Output "Full Setup with NEW password complete!"
