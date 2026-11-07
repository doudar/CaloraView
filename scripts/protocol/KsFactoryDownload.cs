// Factory-table download only. Compile together with KsCameraControl.cs for its
// internal Windows COM definitions. No upload, reset, erase or settings writes.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;

namespace Caloraview.Protocol {
    public sealed class FactoryTableResult {
        public int FileType;
        public string Name, Error, Sha256, DevicePath, DataPath;
        public uint NodeId;
        public long AnnouncedBytes, DownloadedBytes;
        public List<KsQueryResult> Transactions = new List<KsQueryResult>();
    }
    public static class KsFactoryDownload {
        static readonly Guid Set = new Guid("a29e7641-de04-47e3-8b2b-f4341aff003b");
        static readonly Guid DeviceSpecific = new Guid("941c7ac0-c559-11d0-8a2b-00a0c9255ac1");
        const uint Topology = 0x10000000;
        static string Hex(byte[] data) { return BitConverter.ToString(data).Replace("-", "").ToLowerInvariant(); }
        static void Release(object item) { if (item != null && Marshal.IsComObject(item)) Marshal.ReleaseComObject(item); }
        static string Property(IPropertyBag bag, string name) {
            object value;
            return bag.Read(name, out value, IntPtr.Zero) >= 0 ? Convert.ToString(value) : "";
        }
        public static bool DevicePathMatches(string path,string match) {
            if(String.IsNullOrEmpty(path)||String.IsNullOrEmpty(match))return false;
            // Research callers may select the model only. Production callers
            // pass the complete selected interface instance; never prefix-match it.
            if(match.IndexOf('#')<0)return path.IndexOf(match,StringComparison.OrdinalIgnoreCase)>=0;
            int start=path.IndexOf("vid_38be&pid_0184",StringComparison.OrdinalIgnoreCase);
            if(start<0)return false;
            int end=path.IndexOf("#{",start,StringComparison.Ordinal);
            if(end<=start)return false;
            return String.Equals(path.Substring(start,end-start),match,StringComparison.OrdinalIgnoreCase);
        }
        static byte[] Get(IKsControl control, uint node, uint selector, uint length, List<KsQueryResult> log, string operation, out uint returned) {
            if (selector != 1 && selector != 3 && selector != 4 && selector != 5 && selector != 6 && selector != 26) throw new ArgumentException("Factory read selector is not allowlisted.");
            if (length > 4096) throw new ArgumentOutOfRangeException("length");
            IntPtr memory = length == 0 ? IntPtr.Zero : Marshal.AllocHGlobal((int)length);
            try {
                if (length > 0) { var sentinel=new byte[length]; for(int i=0;i<sentinel.Length;i++) sentinel[i]=0xa5; Marshal.Copy(sentinel,0,memory,(int)length); }
                var property = new KsNodeProperty { Set=Set, Id=selector, Flags=1|Topology, NodeId=node };
                int hr = control.KsProperty(ref property, (uint)Marshal.SizeOf(typeof(KsNodeProperty)), memory, length, out returned);
                byte[] data = new byte[hr >= 0 ? Math.Min(length, returned) : 0];
                if (data.Length > 0) Marshal.Copy(memory, data, 0, data.Length);
                string note=null;
                if (length>0 && returned==0) {var diagnostic=new byte[length]; Marshal.Copy(memory,diagnostic,0,(int)length); note="Untrusted allocated buffer after zero-byte result (initial filla5): "+Hex(diagnostic);}
                log.Add(new KsQueryResult { Operation=operation, Selector=selector, HResult="0x"+unchecked((uint)hr).ToString("x8"), RequestedBytes=length, ReturnedBytes=returned, Hex=Hex(data), Note=note, TimestampUtc=DateTime.UtcNow.ToString("o") });
                // Zero-length sizing may return ERROR_MORE_DATA/INSUFFICIENT_BUFFER.
                if (length != 0 || returned == 0) Marshal.ThrowExceptionForHR(hr);
                return data;
            } finally { if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory); }
        }
        static byte[] SizedGet(IKsControl control, uint node, uint selector, List<KsQueryResult> log, string operation, bool allowShortFileChunk=false) {
            uint required, returned;
            Get(control,node,selector,0,log,operation+"_SIZE",out required);
            if (required == 0 || required > 512) throw new InvalidOperationException("Unexpected factory transfer length: " + required);
            byte[] value = Get(control,node,selector,required,log,operation,out returned);
            // Native unchunked file reads use the actual returned size; a short
            // final packet is valid if it still has a header and some payload.
            if(allowShortFileChunk && returned>=6 && returned<=required && value.Length==returned) return value;
            if (returned != required || value.Length != required) {
                Status(control,node,log);
                // Read-only diagnostic of the vendor's512-byte packet capacity.
                // Do not interpret this as a valid file stream after a short read.
                uint diagnosticReturned;
                Get(control,node,selector,512,log,"SHORT_READ_DIAGNOSTIC_512",out diagnosticReturned);
                throw new InvalidOperationException("Truncated factory transfer; recorded status and512-byte read diagnostic.");
            }
            return value;
        }
        static byte[] DirectGet(IKsControl control,uint node,uint selector,uint expected,List<KsQueryResult> log,string operation) {
            // IKsControl itself sends GET_LEN before GET_CUR. A preceding zero-
            // buffer sizing call introduces an extra GET_LEN absent on Android.
            uint actual;
            byte[] value=Get(control,node,selector,expected,log,operation,out actual);
            if(actual!=expected || value.Length!=expected) throw new InvalidDataException("Direct read length mismatch: expected "+expected+", returned "+actual+". No follow-up packet consumed.");
            return value;
        }
        static void SelectDownload(IKsControl control, uint node, byte subcommand, List<KsQueryResult> log) {
            if (subcommand != 1 && subcommand != 2) throw new ArgumentException("Only factory download selection is permitted.");
            WriteExact(control,node,5,new byte[] {26,subcommand,1,0},log,"SELECT_FACTORY_DOWNLOAD");
        }
        static void WriteExact(IKsControl control, uint node, uint selector, byte[] value, List<KsQueryResult> log, string operation) {
            bool select = selector == 5 && value.Length == 4 && ((value[0] == 26 && (value[1] == 1 || value[1] == 2)) || (value[0] == 1 && value[1] == 1) || (value[0] == 3 && value[1] == 14)) && value[2] == 1 && value[3] == 0;
            bool source = selector == 26 && value.Length == 13 && value[0] == 2 && value[1] == 1 && value[2] == 0 && value[3] == 0 && value[4] == 0 && IsAllowed(value[5]) && value[6] == 1;
            if (source) for (int index=7; index<value.Length; index++) if(value[index]!=0) source=false;
            bool sourceLength = selector == 26 && Hex(value)=="0102000000";
            if (!select && !source && !sourceLength) throw new InvalidOperationException("Only exact download-source requests are allowed; uploads and settings are prohibited.");
            IntPtr memory = Marshal.AllocHGlobal(value.Length);
            try {
                Marshal.Copy(value,0,memory,value.Length);
                var property = new KsNodeProperty { Set=Set, Id=selector, Flags=2|Topology, NodeId=node };
                uint returned;
                int hr = control.KsProperty(ref property,(uint)Marshal.SizeOf(typeof(KsNodeProperty)),memory,(uint)value.Length,out returned);
                log.Add(new KsQueryResult { Operation=operation, Selector=selector, HResult="0x"+unchecked((uint)hr).ToString("x8"), RequestedBytes=(uint)value.Length, ReturnedBytes=returned, RequestHex=Hex(value), TimestampUtc=DateTime.UtcNow.ToString("o") });
                Marshal.ThrowExceptionForHR(hr);
            } finally { Marshal.FreeHGlobal(memory); }
        }
        static bool IsAllowed(int type) { return type==4 || type==5 || type==11 || type==14; }
        public static int GetFileChunkPayloadLength(byte[] packet,long announced,long accumulated) {
            if(packet==null || packet.Length<=5 || packet.Length>512) throw new InvalidDataException("Factory chunk must contain a five-byte header and bounded payload.");
            if(announced<=0 || accumulated<0 || accumulated>=announced) throw new InvalidDataException("Invalid factory download bounds.");
            int count=packet.Length-5;
            // Native0x395018 rejects overrun; it does not trim trailing padding.
            if(count>announced-accumulated) throw new InvalidDataException("Factory chunk exceeds announced total; padding is not assumed.");
            // Native preserves byte0 and uint32LE1 without interpreting them.
            // Keep those bytes in transaction logs; do not invent sequence rules.
            return count;
        }
        static string Name(int type) { return type==2011 ? "DeviceIdentity" : type==2054 ? "ThermometryWireBody" : type==4 ? "BPM" : type==5 ? "VC" : type==11 ? "KMatrix" : "KMatrix2"; }
        static void ReadThermometry(IKsControl control,FactoryTableResult result,string output,bool sizeOnly,bool directLengths) {
            var log=result.Transactions;
            WriteExact(control,result.NodeId,5,new byte[] {3,14,1,0},log,"SELECT_THERMOMETRY_CALIBRATION");
            byte[] first=directLengths ? DirectGet(control,result.NodeId,3,5,log,"THERMOMETRY_SIZE_DIRECT") : SizedGet(control,result.NodeId,3,log,"THERMOMETRY_SIZE");
            if(first.Length!=5) throw new InvalidDataException("Thermometry size response is not exactly five bytes.");
            uint total=BitConverter.ToUInt32(first,1);
            if(total<68 || total>4194304) throw new InvalidDataException("Invalid or unsupported thermometry body size: "+total);
            result.AnnouncedBytes=total;
            if(sizeOnly) return;
            var content=new MemoryStream();
            var deadline=DateTime.UtcNow.AddSeconds(25);
            for(int chunk=0;content.Length<total;chunk++) {
                if(chunk>=8274 || DateTime.UtcNow>deadline) throw new TimeoutException("Bounded thermometry read deadline exceeded.");
                int count=(int)Math.Min(507,total-content.Length);
                uint actual;
                // UVC20 chunked read keeps its chosen count+5 transfer length.
                byte[] packet=Get(control,result.NodeId,3,(uint)(count+5),log,"THERMOMETRY_CHUNK_"+chunk,out actual);
                if(actual!=count+5 || packet.Length!=actual) {Status(control,result.NodeId,log);throw new InvalidDataException("Thermometry chunk length differs from the native expected length.");}
                content.Write(packet,5,count);
                result.DownloadedBytes=content.Length;
            }
            Status(control,result.NodeId,log);
            byte[] body=content.ToArray();
            // Save only a complete reassembled wire body; its filename explicitly
            // distinguishes it from the extracted calibration file at body+68.
            using(var sha=SHA256.Create()) result.Sha256=Hex(sha.ComputeHash(body));
            string directory=Path.GetFullPath(output);Directory.CreateDirectory(directory);
            result.DataPath=Path.Combine(directory,result.Name+"-"+result.Sha256.Substring(0,16)+".bin");
            File.WriteAllBytes(result.DataPath,body);
        }
        static void Status(IKsControl control,uint node,List<KsQueryResult> log) {
            uint returned;
            byte[] status=Get(control,node,6,1,log,"COMMAND_STATUS",out returned);
            if (status.Length!=1 || status[0]!=0) throw new InvalidOperationException("Camera rejected factory download: "+Hex(status));
        }
        static void Download(IKsControl control, FactoryTableResult result, string output, bool sizeOnly,bool directLengths) {
            var log=result.Transactions;
            uint returned;
            byte[] version=Get(control,result.NodeId,4,4,log,"PROTOCOL_VERSION",out returned);
            if (Hex(version)!="322e3000") throw new InvalidOperationException("Only the verified UVC2.0 firmware protocol is supported.");
            // SDK2011 device identity is selector1/subcommand1; read before file
            // selection to preserve firmware/model evidence and check transport.
            WriteExact(control,result.NodeId,5,new byte[] {1,1,1,0},log,"SELECT_DEVICE_IDENTITY");
            if(directLengths) DirectGet(control,result.NodeId,1,488,log,"DEVICE_IDENTITY_DIRECT");
            else SizedGet(control,result.NodeId,1,log,"DEVICE_IDENTITY");
            if(result.FileType==2011)return;
            if(result.FileType==2054) {ReadThermometry(control,result,output,sizeOnly,directLengths);return;}
            SelectDownload(control,result.NodeId,1,log);
            // The SDK allocates a zeroed512-byte packet and sends the length
            // returned by GetDataLen, even when the logical source request is2bytes.
            if(!directLengths) {
                uint sourceLength;
                Get(control,result.NodeId,26,0,log,"FACTORY_SOURCE_SET_SIZE",out sourceLength);
                if(sourceLength<2 || sourceLength>512) throw new InvalidOperationException("Unverified factory source transfer size: "+sourceLength);
            }
            // SDK503 requests chunked transport (external context+0x48=1).
            // First declare the2 logical bytes with INTER_COMMON_GET_LEN_V20;
            // its converter forces byte0=1 (0x3a47a0), then sends one data chunk.
            WriteExact(control,result.NodeId,26,new byte[] {1,2,0,0,0},log,"DECLARE_FACTORY_SOURCE_LENGTH");
            // ConvertData<INTER_DATA_FILETYPE> reports8bytes (only2 nonzero).
            // UVC20 chunk header is byte2 + u32LE sequence1, followed by8 bytes.
            byte[] source=new byte[13]; source[0]=2; source[1]=1; source[5]=(byte)result.FileType; source[6]=1;
            WriteExact(control,result.NodeId,26,source,log,"SELECT_FACTORY_FILE_TYPE");
            Status(control,result.NodeId,log);
            SelectDownload(control,result.NodeId,2,log);
            byte[] first=directLengths ? DirectGet(control,result.NodeId,26,5,log,"FACTORY_FILE_SIZE_DIRECT") : SizedGet(control,result.NodeId,26,log,"FACTORY_FILE_SIZE");
            if(first.Length!=5) throw new InvalidOperationException("Expected five-byte factory size response, received "+first.Length+"; no data interpreted.");
            uint total=BitConverter.ToUInt32(first,1);
            uint capacity=result.FileType==4 ? 16384u : 98304u;
            if(total==0 || total>capacity) throw new InvalidOperationException("Invalid factory file size: "+total);
            result.AnnouncedBytes=total;
            if(sizeOnly) return;
            var content=new MemoryStream();
            var deadline=DateTime.UtcNow.AddSeconds(60);
            int chunk=0;
            while(content.Length<total) {
                if(DateTime.UtcNow>deadline || chunk>=1024) throw new TimeoutException("Factory download exceeded bounded duration/chunk count.");
                byte[] packet=directLengths ? DirectGet(control,result.NodeId,26,(uint)Math.Min(512,total-content.Length+5),log,"FACTORY_FILE_CHUNK_DIRECT_"+chunk) : SizedGet(control,result.NodeId,26,log,"FACTORY_FILE_CHUNK_"+chunk,true);
                int count=GetFileChunkPayloadLength(packet,total,content.Length);
                content.Write(packet,5,count);
                result.DownloadedBytes=content.Length;
                chunk++;
            }
            Status(control,result.NodeId,log);
            byte[] bytes=content.ToArray();
            using(var sha=SHA256.Create()) result.Sha256=Hex(sha.ComputeHash(bytes));
            string directory=Path.GetFullPath(output);
            Directory.CreateDirectory(directory);
            result.DataPath=Path.Combine(directory,result.Name+"-"+result.Sha256.Substring(0,16)+".bin");
            File.WriteAllBytes(result.DataPath,bytes);
        }
        public static List<FactoryTableResult> Read(string deviceMatch,int[] fileTypes,string outputDirectory,bool sizeOnly) {
            return Read(deviceMatch,fileTypes,outputDirectory,sizeOnly,false);
        }
        public static List<FactoryTableResult> Read(string deviceMatch,int[] fileTypes,string outputDirectory,bool sizeOnly,bool directLengths) {
            if(String.IsNullOrWhiteSpace(deviceMatch) || deviceMatch.IndexOf("vid_38be&pid_0184",StringComparison.OrdinalIgnoreCase)<0) throw new ArgumentException("This helper is limited to the verified SK02 USB ID.");
            if(fileTypes==null || fileTypes.Length==0 || fileTypes.Length>4) throw new ArgumentException("Select one to four known factory file types.");
            foreach(int type in fileTypes) if(!IsAllowed(type) && type!=2054 && type!=2011) throw new ArgumentException("Unknown factory file type or read command.");
            var results=new List<FactoryTableResult>();
            Guid category=new Guid("860BB310-5D01-11D0-BD3B-00A0C911CE86");
            object enumeratorObject=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("62BE5D10-60EB-11D0-BD3B-00A0C911CE86")));
            IEnumMoniker enumerator=null;
            try {
                Marshal.ThrowExceptionForHR(((ICreateDevEnum)enumeratorObject).CreateClassEnumerator(ref category,out enumerator,0));
                if(enumerator==null) return results;
                var monikers=new IMoniker[1];
                while(enumerator.Next(1,monikers,IntPtr.Zero)==0) {
                    object storage=null,filter=null;
                    IMoniker moniker=monikers[0];
                    try {
                        Guid bagId=typeof(IPropertyBag).GUID;
                        moniker.BindToStorage(null,null,ref bagId,out storage);
                        string path=Property((IPropertyBag)storage,"DevicePath");
                        if(!DevicePathMatches(path,deviceMatch)) continue;
                        Guid filterId=new Guid("56A86895-0AD4-11CE-B03A-0020AF0BA770");
                        moniker.BindToObject(null,null,ref filterId,out filter);
                        var topology=(IKsTopologyInfo)filter;
                        uint nodes;
                        Marshal.ThrowExceptionForHR(topology.get_NumNodes(out nodes));
                        if(nodes>256) throw new InvalidOperationException("Invalid topology.");
                        for(uint node=0;node<nodes;node++) {
                            Guid type;
                            Marshal.ThrowExceptionForHR(topology.get_NodeType(node,out type));
                            if(type!=Set && type!=DeviceSpecific) continue;
                            object nodeObject=null;
                            try {
                                IKsControl control=null;
                                // Prefer the official node-instance route for
                                // this diagnostic; fall back to filter KS if absent.
                                Guid controlId=typeof(IKsControl).GUID;
                                int nodeHr=topology.CreateNodeInstance(node,ref controlId,out nodeObject);
                                if(nodeHr>=0) control=nodeObject as IKsControl;
                                if(control==null) control=filter as IKsControl;
                                if(control==null) throw new InvalidOperationException("Camera exposes no KS control interface.");
                                foreach(int fileType in fileTypes) {
                                    var result=new FactoryTableResult {FileType=fileType,Name=Name(fileType),DevicePath=path,NodeId=node};
                                    results.Add(result);
                                    try { Download(control,result,outputDirectory,sizeOnly,directLengths); }
                                    catch(Exception error) { result.Error=error.Message; return results; }
                                }
                                return results;
                            } finally {Release(nodeObject);}
                        }
                    } finally {Release(filter);Release(storage);Release(moniker);}
                }
                return results;
            } finally {Release(enumerator);Release(enumeratorObject);}
        }
    }
}
