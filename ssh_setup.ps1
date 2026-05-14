$password = "95bAA8eMfkCV"
$user = "ubuntu"
$ip = "57.129.134.155"

$si = New-Object System.Diagnostics.ProcessStartInfo
$si.FileName = "ssh"
$si.Arguments = "-o StrictHostKeyChecking=no $user@$ip"
$si.RedirectStandardInput = $true
$si.RedirectStandardOutput = $true
$si.RedirectStandardError = $true
$si.UseShellExecute = $false

$p = [System.Diagnostics.Process]::Start($si)
Start-Sleep -Seconds 5

$p.StandardInput.WriteLine($password)
Start-Sleep -Seconds 5

# Thiết lập chế độ không tương tác để tránh bị kẹt màn hình tím
$p.StandardInput.WriteLine("export DEBIAN_FRONTEND=noninteractive")
$p.StandardInput.WriteLine("sudo apt-get update")
$p.StandardInput.WriteLine($password)
Start-Sleep -Seconds 10

$p.StandardInput.WriteLine("sudo apt-get -y -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' install nodejs npm ffmpeg")
Start-Sleep -Seconds 45

$p.StandardInput.WriteLine("sudo npm install pm2 -g")
Start-Sleep -Seconds 15

$p.StandardInput.WriteLine("mkdir -p ~/Livenew")
$p.StandardInput.WriteLine("exit")

$p.WaitForExit()
Write-Output "Setup step 1 (Robust) complete."
