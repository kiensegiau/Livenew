// ffmpeg GIẢ cho test: ghi lại tham số (-i <file>) vào ffmpeg_calls.txt cạnh file exe, không phát gì lên mạng.
// - File đầu vào không tồn tại / là link http → in lỗi, thoát mã 1 (giống ffmpeg thật).
// - Ngược lại: in "frame=..." ra stderr mỗi 0.5s, chạy tới khi nhận 'q' từ stdin (thoát 0) hoặc bị kill.
using System;
using System.IO;
using System.Threading;

class FakeFFmpeg {
  static int Main(string[] args) {
    string input = "";
    for (int i = 0; i < args.Length - 1; i++) if (args[i] == "-i") input = args[i + 1];
    string log = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ffmpeg_calls.txt");
    try { File.AppendAllText(log, input + Environment.NewLine); } catch {}
    if (input == "" || input.StartsWith("http", StringComparison.OrdinalIgnoreCase) || !File.Exists(input)) {
      Console.Error.WriteLine(input + ": No such file or directory");
      return 1;
    }
    bool quit = false;
    var t = new Thread(() => {
      try { int c; while ((c = Console.In.Read()) != -1) { if (c == 'q') { quit = true; break; } } } catch {}
    });
    t.IsBackground = true; t.Start();
    int n = 0;
    while (!quit) {
      Console.Error.WriteLine("frame=" + (n += 15) + " fps=30 q=-1.0 size=1024kB time=00:00:01.00 bitrate=4500.0kbits/s speed=1x");
      Thread.Sleep(500);
    }
    return 0;
  }
}
