Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "YouTube Live Controller"
$form.Size = New-Object System.Drawing.Size(480, 320)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false

# Stream Key
$lblKey = New-Object System.Windows.Forms.Label
$lblKey.Text = "Stream Key:"
$lblKey.Location = New-Object System.Drawing.Point(20, 20)
$lblKey.AutoSize = $true
$form.Controls.Add($lblKey)

$txtKey = New-Object System.Windows.Forms.TextBox
$txtKey.Location = New-Object System.Drawing.Point(20, 42)
$txtKey.Width = 420
$form.Controls.Add($txtKey)

# Chọn Video
$lblVid = New-Object System.Windows.Forms.Label
$lblVid.Text = "File Video:"
$lblVid.Location = New-Object System.Drawing.Point(20, 80)
$lblVid.AutoSize = $true
$form.Controls.Add($lblVid)

$txtVid = New-Object System.Windows.Forms.TextBox
$txtVid.Location = New-Object System.Drawing.Point(20, 102)
$txtVid.Width = 320
$txtVid.ReadOnly = $true
$form.Controls.Add($txtVid)

$btnBrowse = New-Object System.Windows.Forms.Button
$btnBrowse.Text = "Browse..."
$btnBrowse.Location = New-Object System.Drawing.Point(350, 100)
$btnBrowse.Width = 90
$btnBrowse.Add_Click({
    $fd = New-Object System.Windows.Forms.OpenFileDialog
    $fd.Filter = "Video Files|*.mp4;*.mkv;*.avi"
    if ($fd.ShowDialog() -eq "OK") { $txtVid.Text = $fd.FileName }
})
$form.Controls.Add($btnBrowse)

# Chế độ + Số phút (cùng hàng)
$lblMode = New-Object System.Windows.Forms.Label
$lblMode.Text = "Chế độ:"
$lblMode.Location = New-Object System.Drawing.Point(20, 145)
$lblMode.AutoSize = $true
$form.Controls.Add($lblMode)

$comboMode = New-Object System.Windows.Forms.ComboBox
$comboMode.Location = New-Object System.Drawing.Point(20, 165)
$comboMode.Width = 200
$comboMode.DropDownStyle = "DropDownList"
$comboMode.Items.Add("Vong lap (Hen gio nghi)") | Out-Null
$comboMode.Items.Add("Phat 1 lan (Het tu nghi)") | Out-Null
$comboMode.SelectedIndex = 0
$form.Controls.Add($comboMode)

$lblMin = New-Object System.Windows.Forms.Label
$lblMin.Text = "So phut Live:"
$lblMin.Location = New-Object System.Drawing.Point(240, 145)
$lblMin.AutoSize = $true
$form.Controls.Add($lblMin)

$txtMin = New-Object System.Windows.Forms.TextBox
$txtMin.Location = New-Object System.Drawing.Point(240, 165)
$txtMin.Width = 80
$txtMin.Text = "1440"
$form.Controls.Add($txtMin)

# Nút Bắt Đầu Live
$btnStart = New-Object System.Windows.Forms.Button
$btnStart.Text = "BAT DAU LIVE"
$btnStart.Location = New-Object System.Drawing.Point(20, 215)
$btnStart.Size = New-Object System.Drawing.Size(420, 50)
$btnStart.BackColor = [System.Drawing.Color]::LightGreen
$btnStart.Font = New-Object System.Drawing.Font("Arial", 12, [System.Drawing.FontStyle]::Bold)
$btnStart.Add_Click({
    if ($txtKey.Text -eq "" -or $txtVid.Text -eq "") {
        [System.Windows.Forms.MessageBox]::Show("Vui long nhap du Stream Key va chon Video!")
        return
    }
    $loopParam = if ($comboMode.SelectedIndex -eq 0) { "-stream_loop -1" } else { "" }
    $timeParam = if ($comboMode.SelectedIndex -eq 0) { "-t $([int]$txtMin.Text * 60)" } else { "" }
    $ffArgs = "/k ffmpeg $loopParam -re -i `"$($txtVid.Text)`" $timeParam -c:v copy -c:a copy -copyts -start_at_zero -bsf:a aac_adtstoasc -bufsize 10000k -maxrate 5500k -f flv `"rtmp://a.rtmp.youtube.com/live2/$($txtKey.Text)`""
    Start-Process cmd.exe -ArgumentList $ffArgs
    [System.Windows.Forms.MessageBox]::Show("Da kich hoat luong Live! Co the bam them de mo luong moi.")
})
$form.Controls.Add($btnStart)

$form.ShowDialog()
