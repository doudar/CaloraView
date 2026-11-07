using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace Caloraview.Protocol {
    public static class CalibrationExport {
        [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode)]
        static extern uint CM_Locate_DevNodeW(out uint node,string id,uint flags);
        [DllImport("cfgmgr32.dll")]
        static extern uint CM_Get_Parent(out uint parent,uint node,uint flags);
        [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode)]
        static extern uint CM_Get_Device_IDW(uint node,StringBuilder value,uint length,uint flags);
        static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=8*1024*1024 };
        static readonly UTF8Encoding Utf8=new UTF8Encoding(false);
        static string Hash(byte[] bytes) {using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
        public static string InstanceMatch(string moniker) {
            if(String.IsNullOrWhiteSpace(moniker))throw new ArgumentException("An exact camera moniker is required.");
            int start=moniker.IndexOf("vid_38be&pid_0184",StringComparison.OrdinalIgnoreCase);
            if(start<0)throw new ArgumentException("Only the verified SK02 USB model is supported.");
            int end=moniker.IndexOf("#{",start,StringComparison.Ordinal);
            string instance=end>start?moniker.Substring(start,end-start):moniker.Substring(start);
            if(!Regex.IsMatch(instance,@"^vid_38be&pid_0184&mi_00#[^#\\/]+$",RegexOptions.IgnoreCase))throw new ArgumentException("A complete SK02 interface-0 instance path is required.");
            return instance;
        }
        public static string SerialFromParentId(string id) {
            var match=Regex.Match(id??"",@"^USB\\VID_38BE&PID_0184\\([\x21-\x7e]{1,256})$",RegexOptions.IgnoreCase);
            if(!match.Success || match.Groups[1].Value.IndexOfAny(new char[]{'&','\\','/'})>=0)return null;
            return match.Groups[1].Value;
        }
        public static string ResolveSerial(string instance) {
            uint node;
            string id="USB\\"+instance.Replace('#','\\');
            if(CM_Locate_DevNodeW(out node,id,0)!=0)throw new InvalidOperationException("Selected camera instance is no longer present.");
            for(int depth=0;depth<8;depth++) {
                var text=new StringBuilder(512);
                if(CM_Get_Device_IDW(node,text,512,0)!=0)throw new InvalidOperationException("Cannot read selected camera PnP identity.");
                string serial=SerialFromParentId(text.ToString());
                if(serial!=null)return serial;
                uint parent;if(CM_Get_Parent(out parent,node,0)!=0)break;node=parent;
            }
            throw new InvalidOperationException("No unique SK02 USB serial found for the selected camera.");
        }
        static byte[] HexBytes(string value) {
            if(value==null || value.Length%2!=0)throw new InvalidDataException("Invalid recorded control bytes.");
            byte[] bytes=new byte[value.Length/2];for(int i=0;i<bytes.Length;i++)bytes[i]=Convert.ToByte(value.Substring(i*2,2),16);return bytes;
        }
        static void WriteNew(string root,string name,byte[] bytes) {
            using(var file=new FileStream(Path.Combine(root,name),FileMode.CreateNew,FileAccess.Write,FileShare.None))file.Write(bytes,0,bytes.Length);
        }
        public static object Identify(string moniker) {
            string instance=InstanceMatch(moniker),serial=ResolveSerial(instance);
            // SDK2011 is a query only. DirectLengths avoids redundant GET_LEN.
            var read=KsFactoryDownload.Read(instance,new int[]{2011},null,true,true);
            if(read.Count!=1)throw new InvalidOperationException("Expected one selected SK02 identity response.");
            if(!String.IsNullOrEmpty(read[0].Error))throw new IOException(read[0].Error);
            byte[] identity=null;
            foreach(var entry in read[0].Transactions)if(entry.Operation=="DEVICE_IDENTITY_DIRECT")identity=HexBytes(entry.Hex);
            if(identity==null || identity.Length!=488)throw new InvalidDataException("Incomplete camera identity response.");
            if(ResolveSerial(instance)!=serial)throw new IOException("Camera serial changed during identity query.");
            return new{type="result",ok=true,serial=serial,protocolVersion="2.0",deviceIdentitySha256=Hash(identity),deviceIdentityHex=BitConverter.ToString(identity).Replace("-","").ToLowerInvariant()};
        }
        public static object Download(string moniker,string outputDirectory,Action<string> progress) {
            string instance=InstanceMatch(moniker),serial=ResolveSerial(instance);
            string root=Path.GetFullPath(outputDirectory);
            if(Directory.Exists(root) && Directory.GetFileSystemEntries(root).Length!=0)throw new IOException("Calibration output directory must be empty.");
            Directory.CreateDirectory(root);
            if((File.GetAttributes(root)&FileAttributes.ReparsePoint)!=0)throw new IOException("Calibration output directory cannot be a link.");
            string evidence=Path.Combine(root,"transfer-evidence");Directory.CreateDirectory(evidence);
            var results=new List<FactoryTableResult>();
            int[] types={4,11,14,2054,5};string[] names={"BPM.bin","KMatrix.bin","KMatrix2.bin","thermometry-wire-body.bin","VC.bin"};
            var content=new Dictionary<string,byte[]>();
            var optionalOutcomes=new Dictionary<string,string>();
            for(int i=0;i<types.Length;i++) {
                progress("Reading "+names[i]);
                var read=KsFactoryDownload.Read(instance,new int[]{types[i]},evidence,false,true);
                if(read.Count!=1)throw new InvalidOperationException("Expected one selected SK02 factory response.");
                var result=read[0];results.Add(result);
                File.WriteAllText(Path.Combine(evidence,"transactions.json"),Json.Serialize(results),Utf8);
                if(!String.IsNullOrEmpty(result.Error)) {
                    if(types[i]==5) {optionalOutcomes["VC.bin"]="unavailable: "+result.Error;continue;}
                    throw new IOException(result.Error);
                }
                if(result.DownloadedBytes!=result.AnnouncedBytes || result.DataPath==null)throw new IOException("Incomplete factory file.");
                byte[] bytes=File.ReadAllBytes(result.DataPath);
                if(bytes.Length!=result.AnnouncedBytes || Hash(bytes)!=result.Sha256)throw new IOException("Factory file integrity check failed.");
                content.Add(names[i],bytes);
                foreach(var entry in result.Transactions)if(entry.Operation=="DEVICE_IDENTITY_DIRECT") {
                    byte[] identity=HexBytes(entry.Hex);
                    if(content.ContainsKey("device-identity.bin")) {
                        if(Hash(content["device-identity.bin"])!=Hash(identity))throw new IOException("Camera identity changed during export.");
                    }else content.Add("device-identity.bin",identity);
                }
            }
            if(ResolveSerial(instance)!=serial)throw new IOException("Camera serial changed during export.");
            byte[] body=content["thermometry-wire-body.bin"];
            if(body.Length<69 || BitConverter.ToUInt32(body,64)!=body.Length-68)throw new InvalidDataException("Thermometry body length is inconsistent.");
            byte[] calibration=new byte[body.Length-68];Array.Copy(body,68,calibration,0,calibration.Length);content.Add("thermometry-calibration.bin",calibration);
            var trace=new StringBuilder("timestamp_utc\toperation\tselector\trequested\treturned\thresult\trequest_hex\tresponse_hex\n");
            foreach(var result in results)foreach(var entry in result.Transactions)trace.Append(entry.TimestampUtc).Append('\t').Append(entry.Operation).Append('\t').Append(entry.Selector).Append('\t').Append(entry.RequestedBytes).Append('\t').Append(entry.ReturnedBytes).Append('\t').Append(entry.HResult).Append('\t').Append(entry.RequestHex??"").Append('\t').Append(entry.Hex??"").Append('\n');
            content.Add("transactions.tsv",Utf8.GetBytes(trace.ToString()));
            var files=new List<object>();var outcomes=new Dictionary<string,string>(optionalOutcomes);
            foreach(var entry in content) {WriteNew(root,entry.Key,entry.Value);files.Add(new{name=entry.Key,bytes=entry.Value.Length,sha256=Hash(entry.Value)});outcomes[entry.Key]="complete";}
            var manifest=new {format="accuheat-calibration-export-v1",createdUtc=DateTime.UtcNow.ToString("o"),protocolVersion="2.0",complete=true,
                device=new{vendorId=0x38be,productId=0x0184,serial=serial,model="SK02"},
                provenance=new{method="Windows IKsControl",transport="direct-length",identity="exact selected interface PnP parent USB serial"},files=files,outcomes=outcomes};
            WriteNew(root,"manifest.json",Utf8.GetBytes(Json.Serialize(manifest)));
            return new{type="result",ok=true,serial=serial,directory=root,manifestPath=Path.Combine(root,"manifest.json"),files=files,radiometryValidated=false};
        }
    }
}
