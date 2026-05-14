$password = "95bAA8eMfkCV"
$user = "ubuntu"
$ip = "57.129.134.155"
$gitRepo = "https://github.com/kiensegiau/Livenew.git"

# Nội dung file config (để bảo mật, không lấy từ git)
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

$si = New-Object System.Diagnostics.ProcessStartInfo
$si.FileName = "ssh"
$si.Arguments = "-o StrictHostKeyChecking=no $user@$ip"
$si.RedirectStandardInput = $true
$si.UseShellExecute = $false

$p = [System.Diagnostics.Process]::Start($si)
Start-Sleep -Seconds 5
$p.StandardInput.WriteLine($password)
Start-Sleep -Seconds 5

# Xóa thư mục cũ nếu có và clone mới
$p.StandardInput.WriteLine("rm -rf ~/Livenew")
$p.StandardInput.WriteLine("git clone $gitRepo ~/Livenew")
Start-Sleep -Seconds 10

# Vào thư mục và cài đặt
$p.StandardInput.WriteLine("cd ~/Livenew")
$p.StandardInput.WriteLine("npm install")
Start-Sleep -Seconds 15

# Tạo file config từ base64
$p.StandardInput.WriteLine("echo '$configBase64' | base64 -d > bot_config.json")
Start-Sleep -Seconds 2

# Khởi chạy PM2
$p.StandardInput.WriteLine("pm2 delete live-controller 2>/dev/null")
$p.StandardInput.WriteLine("pm2 start server.js --name live-controller")
$p.StandardInput.WriteLine("pm2 save")
$p.StandardInput.WriteLine("exit")

$p.WaitForExit()
Write-Output "Setup via Git complete!"
