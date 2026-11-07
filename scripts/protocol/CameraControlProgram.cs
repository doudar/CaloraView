using System;
using System.Web.Script.Serialization;
using Caloraview.Protocol;

public static class CameraControlProgram {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    static void Output(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    [STAThread]
    public static int Main(string[] args) {
        try {
            if(args.Length==2 && args[0]=="calibration-identity") {
                Output(CalibrationExport.Identify(args[1]));return 0;
            }
            if(args.Length==3 && args[0]=="download-calibration") {
                Output(CalibrationExport.Download(args[1],args[2],delegate(string stage){Output(new{type="stage",stage=stage,timestamp=DateTime.UtcNow.ToString("o")});}));
                return 0;
            }
            if (args.Length != 2 || args[0] != "shutter-reference") throw new ArgumentException("Expected shutter-reference, calibration-identity, or download-calibration with an exact camera moniker.");
            if (args[1].IndexOf("vid_38be&pid_0184", StringComparison.OrdinalIgnoreCase) < 0) throw new ArgumentException("Only the verified SK02 USB model is supported.");
            // FFmpeg and COM spell the moniker prefix differently. Preserve the
            // complete USB hardware/instance portion for an exact device match.
            int start = args[1].IndexOf("vid_38be&pid_0184", StringComparison.OrdinalIgnoreCase);
            int end = args[1].IndexOf("#{", start, StringComparison.Ordinal);
            string identity = end > start ? args[1].Substring(start, end - start) : args[1].Substring(start);
            if (identity.IndexOf('#') < 0) throw new ArgumentException("A complete camera instance path is required.");
            var devices = KsCameraControl.CycleShutter(identity, "a29e7641-de04-47e3-8b2b-f4341aff003b", 1200,
                delegate(string stage) { Output(new { type = "stage", stage = stage, timestamp = DateTime.UtcNow.ToString("o") }); });
            if (devices.Count != 1) throw new InvalidOperationException("Expected exactly one matching camera.");
            foreach (var device in devices) {
                if (!String.IsNullOrEmpty(device.Error)) throw new InvalidOperationException(device.Error);
                foreach (var node in device.Nodes) if (!String.IsNullOrEmpty(node.Error)) throw new InvalidOperationException(node.Error);
            }
            Output(new { type = "result", ok = true, devices = devices });
            return 0;
        } catch (Exception error) { Output(new { type = "result", ok = false, error = error.Message }); return 1; }
    }
}
