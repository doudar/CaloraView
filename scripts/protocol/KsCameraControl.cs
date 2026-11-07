// DirectShow/KS extension-unit inspection and normal shutter actuation. SET is
// restricted to allowlisted command selection and the transient shutter byte.
// No general settings, RESET, flash, firmware or driver replacement are exposed.
// COM signatures follow Windows SDK vidcap.h, strmif.h, and ksproxy.h.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;

namespace Caloraview.Protocol
{
    [ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICreateDevEnum
    {
        [PreserveSig] int CreateClassEnumerator(ref Guid category, out IEnumMoniker enumerator, uint flags);
    }
    [ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyBag
    {
        [PreserveSig] int Read([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Struct)] out object value, IntPtr errorLog);
        [PreserveSig] int Write([MarshalAs(UnmanagedType.LPWStr)] string name, ref object value);
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct TopologyConnection { public uint FromNode, FromPin, ToNode, ToPin; }
    [ComImport, Guid("720D4AC0-7533-11D0-A5D6-28DB04C10000"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IKsTopologyInfo
    {
        [PreserveSig] int get_NumCategories(out uint count);
        [PreserveSig] int get_Category(uint index, out Guid category);
        [PreserveSig] int get_NumConnections(out uint count);
        [PreserveSig] int get_ConnectionInfo(uint index, out TopologyConnection connection);
        [PreserveSig] int get_NodeName(uint node, [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, uint bufferBytes, out uint nameBytes);
        [PreserveSig] int get_NumNodes(out uint count);
        [PreserveSig] int get_NodeType(uint node, out Guid type);
        [PreserveSig] int CreateNodeInstance(uint node, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct KsNodeProperty
    {
        public Guid Set;
        public uint Id, Flags, NodeId, Reserved;
    }
    [ComImport, Guid("28F54685-06FD-11D2-B27A-00A0C9223196"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IKsControl
    {
        [PreserveSig] int KsProperty(ref KsNodeProperty property, uint propertyLength, IntPtr data, uint dataLength, out uint returned);
        [PreserveSig] int KsMethod(IntPtr method, uint methodLength, IntPtr data, uint dataLength, out uint returned);
        [PreserveSig] int KsEvent(IntPtr request, uint requestLength, IntPtr data, uint dataLength, out uint returned);
    }
    public sealed class KsQueryResult
    {
        public string Operation { get; set; }
        public uint Selector { get; set; }
        public string HResult { get; set; }
        public uint RequestedBytes { get; set; }
        public uint ReturnedBytes { get; set; }
        public string Hex { get; set; }
        public string RequestHex { get; set; }
        public string TimestampUtc { get; set; }
        public string Note { get; set; }
    }
    public sealed class KsNodeResult
    {
        public uint NodeId { get; set; }
        public string Type { get; set; }
        public string Name { get; set; }
        public string Error { get; set; }
        public List<KsQueryResult> Queries { get; set; }
        public KsNodeResult() { Queries = new List<KsQueryResult>(); }
    }
    public sealed class KsDeviceResult
    {
        public string FriendlyName { get; set; }
        public string DevicePath { get; set; }
        public string Moniker { get; set; }
        public string Error { get; set; }
        public string PropertySet { get; set; }
        public List<KsNodeResult> Nodes { get; set; }
        public KsDeviceResult() { Nodes = new List<KsNodeResult>(); }
    }

    public static class KsCameraControl
    {
        private const uint Get = 1, BasicSupport = 0x200, Topology = 0x10000000;
        private static readonly Guid DeviceSpecific = new Guid("941c7ac0-c559-11d0-8a2b-00a0c9255ac1");

        private static void Release(object instance)
        {
            if (instance != null && Marshal.IsComObject(instance)) Marshal.ReleaseComObject(instance);
        }
        private static string Property(IPropertyBag bag, string name)
        {
            object value;
            return bag.Read(name, out value, IntPtr.Zero) >= 0 ? Convert.ToString(value) : "";
        }
        private static KsQueryResult Query(IKsControl control, uint node, Guid set, uint selector, uint flags, uint size, string operation)
        {
            // Restrict this helper to reads even if a future caller supplies flags.
            if (flags != Get && flags != BasicSupport) throw new InvalidOperationException("Only read-only KS queries are permitted.");
            if (size > 1048576) throw new ArgumentOutOfRangeException("size");
            IntPtr data = size == 0 ? IntPtr.Zero : Marshal.AllocHGlobal((int)size);
            try
            {
                if (size > 0) Marshal.Copy(new byte[size], 0, data, (int)size);
                var property = new KsNodeProperty { Set = set, Id = selector, Flags = flags | Topology, NodeId = node };
                uint returned;
                int hr = control.KsProperty(ref property, (uint)Marshal.SizeOf(typeof(KsNodeProperty)), data, size, out returned);
                byte[] bytes = new byte[hr >= 0 ? Math.Min(size, returned) : 0];
                if (bytes.Length > 0) Marshal.Copy(data, bytes, 0, bytes.Length);
                return new KsQueryResult {
                    Operation = operation, Selector = selector, HResult = "0x" + unchecked((uint)hr).ToString("x8"),
                    RequestedBytes = size, ReturnedBytes = returned, Hex = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(),
                    TimestampUtc = DateTime.UtcNow.ToString("o")
                };
            }
            finally { if (data != IntPtr.Zero) Marshal.FreeHGlobal(data); }
        }

        private static KsQueryResult SelectRead(IKsControl control, uint node, Guid set, byte[] command)
        {
            // Exact SDK SwitchCommand envelope: selector, subcommand, channel1,0.
            // These two commands retrieve current state and factory calibration.
            bool allowed = command != null && command.Length == 4 && command[2] == 1 && command[3] == 0 &&
                ((command[0] == 2 && command[1] == 5) || (command[0] == 3 && command[1] == 14));
            if (!allowed) throw new InvalidOperationException("This read-selection command is not allowlisted.");
            IntPtr data = Marshal.AllocHGlobal(4);
            try
            {
                Marshal.Copy(command, 0, data, 4);
                var property = new KsNodeProperty { Set = set, Id = 5, Flags = 2 | Topology, NodeId = node };
                uint returned;
                int hr = control.KsProperty(ref property, (uint)Marshal.SizeOf(typeof(KsNodeProperty)), data, 4, out returned);
                return new KsQueryResult { Operation = "SELECT_READ_COMMAND", Selector = 5,
                    HResult = "0x" + unchecked((uint)hr).ToString("x8"), RequestedBytes = 4, ReturnedBytes = returned,
                    Hex = "", RequestHex = BitConverter.ToString(command).Replace("-", "").ToLowerInvariant(), TimestampUtc = DateTime.UtcNow.ToString("o") };
            }
            finally { Marshal.FreeHGlobal(data); }
        }

        private static byte[] HexBytes(string hex)
        {
            var data = new byte[hex.Length / 2];
            for (int i = 0; i < data.Length; i++) data[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
            return data;
        }

        private static void CheckStatus(IKsControl control, uint node, Guid set, List<KsQueryResult> queries)
        {
            var status = Query(control, node, set, 6, Get, 1, "COMMAND_STATUS");
            queries.Add(status);
            if (status.HResult != "0x00000000" || status.Hex != "00") throw new InvalidOperationException("Camera command status is not success: " + status.HResult + "/" + status.Hex);
        }

        private static byte[] ReadEnhancement(IKsControl control, uint node, Guid set, List<KsQueryResult> queries)
        {
            var selection = SelectRead(control, node, set, new byte[] { 2, 5, 1, 0 });
            queries.Add(selection);
            if (selection.HResult != "0x00000000") throw new InvalidOperationException("Enhancement read selection failed.");
            var length = Query(control, node, set, 2, Get, 0, "ENHANCEMENT_GET_SIZE");
            queries.Add(length);
            // Exact known SDK/firmware shapes only; never guess another layout.
            if (length.ReturnedBytes != 186 && length.ReturnedBytes != 226) throw new InvalidOperationException("Unverified enhancement length: " + length.ReturnedBytes);
            var value = Query(control, node, set, 2, Get, length.ReturnedBytes, "ENHANCEMENT_GET_CURRENT");
            queries.Add(value);
            if (value.HResult != "0x00000000" || value.ReturnedBytes != length.ReturnedBytes) throw new InvalidOperationException("Enhancement read failed or was truncated.");
            CheckStatus(control, node, set, queries);
            byte[] data = HexBytes(value.Hex);
            if (data[0] != 1) throw new InvalidOperationException("Unverified enhancement channel prefix.");
            return data;
        }

        private static void ShutterMode(IKsControl control, uint node, Guid set, byte mode, List<KsQueryResult> queries, byte[] preserved = null)
        {
            if (mode != 1 && mode != 2 && mode != 3) throw new InvalidOperationException("Only normal shutter release/down/up are permitted.");
            // Read-modify-write only the proven transient actuator byte. GET and
            // SET share the selected02/05/channel1 command; all other bytes stay.
            byte[] data;
            try { data = ReadEnhancement(control, node, set, queries); }
            catch (Exception error)
            {
                if (preserved == null || (preserved.Length != 186 && preserved.Length != 226) || preserved[0] != 1) throw;
                data = (byte[])preserved.Clone();
                queries.Add(new KsQueryResult { Operation = "RECOVERY_USING_PRESERVED_PAYLOAD", Selector = 2,
                    Note = error.Message, TimestampUtc = DateTime.UtcNow.ToString("o") });
            }
            data[0x2f] = mode;
            IntPtr payload = Marshal.AllocHGlobal(data.Length);
            try
            {
                Marshal.Copy(data, 0, payload, data.Length);
                var property = new KsNodeProperty { Set = set, Id = 2, Flags = 2 | Topology, NodeId = node };
                uint returned;
                int hr = control.KsProperty(ref property, (uint)Marshal.SizeOf(typeof(KsNodeProperty)), payload, (uint)data.Length, out returned);
                queries.Add(new KsQueryResult { Operation = mode == 2 ? "SHUTTER_DOWN" : mode == 3 ? "SHUTTER_UP" : "SHUTTER_RELEASE",
                    Selector = 2, HResult = "0x" + unchecked((uint)hr).ToString("x8"), RequestedBytes = (uint)data.Length,
                    ReturnedBytes = returned, RequestHex = BitConverter.ToString(data).Replace("-", "").ToLowerInvariant(),
                    Hex = "", TimestampUtc = DateTime.UtcNow.ToString("o") });
                Marshal.ThrowExceptionForHR(hr);
                CheckStatus(control, node, set, queries);
            }
            finally { Marshal.FreeHGlobal(payload); }
        }

        private static void NormalShutterCycle(IKsControl control, uint node, Guid set, int holdMilliseconds, List<KsQueryResult> queries, Action<string> stage)
        {
            // Probe before any action. After attempting down, always attempt both
            // up and release, even if the intervening read/status query fails.
            byte[] preserved = ReadEnhancement(control, node, set, queries);
            Exception failure = null;
            try
            {
                ShutterMode(control, node, set, 2, queries);
                Thread.Sleep(100);
                ShutterMode(control, node, set, 1, queries);
                Thread.Sleep(100);
                if (stage != null) stage("closed");
                Thread.Sleep(holdMilliseconds);
            }
            catch (Exception error) { failure = error; }
            finally
            {
                bool opened = false;
                // A reporting callback must never prevent actuator recovery.
                try { if (stage != null) stage("opening"); } catch { }
                try { ShutterMode(control, node, set, 3, queries, preserved); opened = true; }
                catch (Exception error) { failure = new InvalidOperationException((failure == null ? "" : failure.Message + "; ") + "Shutter-up recovery: " + error.Message); }
                finally
                {
                    Thread.Sleep(100);
                    try {
                        ShutterMode(control, node, set, 1, queries, preserved);
                        if (opened && stage != null) stage("opened");
                    }
                    catch (Exception error) { failure = new InvalidOperationException((failure == null ? "" : failure.Message + "; ") + "Shutter-release recovery: " + error.Message); }
                }
            }
            if (failure != null) throw failure;
        }

        public static List<KsDeviceResult> Read(string deviceMatch, string extensionGuid, uint[] selectors, uint fallbackReadBytes)
        {
            return ReadCore(deviceMatch, extensionGuid, selectors, fallbackReadBytes, null, 0, null);
        }

        public static List<KsDeviceResult> ReadSelected(string deviceMatch, string extensionGuid, string command)
        {
            if (command == "image-enhancement-ex") return ReadCore(deviceMatch, extensionGuid, new uint[] { 2 }, 226, new byte[] { 2, 5, 1, 0 }, 0, null);
            if (command == "thermometry-calibration") return ReadCore(deviceMatch, extensionGuid, new uint[] { 3 }, 512, new byte[] { 3, 14, 1, 0 }, 0, null);
            throw new ArgumentException("Unknown read-only command.");
        }

        public static List<KsDeviceResult> CycleShutter(string deviceMatch, string extensionGuid, int holdMilliseconds)
        {
            return CycleShutter(deviceMatch, extensionGuid, holdMilliseconds, null);
        }

        public static List<KsDeviceResult> CycleShutter(string deviceMatch, string extensionGuid, int holdMilliseconds, Action<string> stage)
        {
            if (holdMilliseconds < 500 || holdMilliseconds > 2000) throw new ArgumentOutOfRangeException("holdMilliseconds", "Shutter capture hold must be 500 to 2000 ms.");
            return ReadCore(deviceMatch, extensionGuid, new uint[0], 226, null, holdMilliseconds, stage);
        }

        private static List<KsDeviceResult> ReadCore(string deviceMatch, string extensionGuid, uint[] selectors, uint fallbackReadBytes, byte[] selectCommand, int shutterHold, Action<string> stage)
        {
            if (String.IsNullOrWhiteSpace(deviceMatch)) throw new ArgumentException("An exact device path or VID/PID match is required.");
            if (selectors == null || selectors.Length > 32) throw new ArgumentException("At most 32 selectors may be queried.");
            foreach (uint selector in selectors) if (selector == 0 || selector > 32) throw new ArgumentException("Selectors must be between 1 and 32.");
            if (fallbackReadBytes == 0 || fallbackReadBytes > 65536) throw new ArgumentException("Fallback read length must be 1 to 65536 bytes.");
            Guid set = new Guid(extensionGuid);
            Guid category = new Guid("860BB310-5D01-11D0-BD3B-00A0C911CE86");
            object enumeratorObject = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("62BE5D10-60EB-11D0-BD3B-00A0C911CE86")));
            IEnumMoniker enumerator = null;
            var devices = new List<KsDeviceResult>();
            try
            {
                int enumHr = ((ICreateDevEnum)enumeratorObject).CreateClassEnumerator(ref category, out enumerator, 0);
                if (enumHr < 0) Marshal.ThrowExceptionForHR(enumHr);
                if (enumerator == null) return devices;
                var monikers = new IMoniker[1];
                while (enumerator.Next(1, monikers, IntPtr.Zero) == 0)
                {
                    object storage = null, filter = null;
                    var moniker = monikers[0];
                    try
                    {
                        Guid bagId = typeof(IPropertyBag).GUID;
                        moniker.BindToStorage(null, null, ref bagId, out storage);
                        var bag = (IPropertyBag)storage;
                        string name = Property(bag, "FriendlyName"), devicePath = Property(bag, "DevicePath"), displayName;
                        moniker.GetDisplayName(null, null, out displayName);
                        if ((devicePath + " " + displayName).IndexOf(deviceMatch, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        var device = new KsDeviceResult { FriendlyName = name, DevicePath = devicePath, Moniker = displayName, PropertySet = set.ToString() };
                        devices.Add(device);
                        try
                        {
                            Guid filterId = new Guid("56A86895-0AD4-11CE-B03A-0020AF0BA770");
                            moniker.BindToObject(null, null, ref filterId, out filter);
                            var topology = (IKsTopologyInfo)filter;
                            uint count;
                            Marshal.ThrowExceptionForHR(topology.get_NumNodes(out count));
                            if (count > 256) throw new InvalidOperationException("Unexpected topology node count.");
                            for (uint node = 0; node < count; node++)
                            {
                                Guid type;
                                Marshal.ThrowExceptionForHR(topology.get_NodeType(node, out type));
                                var text = new StringBuilder(512);
                                uint actualNameBytes;
                                topology.get_NodeName(node, text, 1024, out actualNameBytes);
                                var item = new KsNodeResult { NodeId = node, Type = type.ToString(), Name = text.ToString() };
                                device.Nodes.Add(item);
                                if (type != DeviceSpecific && type != set) continue;
                                object nodeObject = null;
                                try
                                {
                                    IKsControl control = filter as IKsControl;
                                    if (control == null) {
                                        Guid controlId = typeof(IKsControl).GUID;
                                        Marshal.ThrowExceptionForHR(topology.CreateNodeInstance(node, ref controlId, out nodeObject));
                                        control = (IKsControl)nodeObject;
                                    }
                                    item.Queries.Add(Query(control, node, set, 0, Get, 512, "EXTENSION_UNIT_INFO"));
                                    if (shutterHold > 0) { NormalShutterCycle(control, node, set, shutterHold, item.Queries, stage); continue; }
                                    if (selectCommand != null) {
                                        var selection = SelectRead(control, node, set, selectCommand);
                                        item.Queries.Add(selection);
                                        if (selection.HResult != "0x00000000") throw new InvalidOperationException("Read-command selection failed: " + selection.HResult);
                                    }
                                    foreach (uint selector in selectors)
                                    {
                                        item.Queries.Add(Query(control, node, set, selector, BasicSupport, 256, "BASIC_SUPPORT"));
                                        var length = Query(control, node, set, selector, Get, 0, "GET_SIZE");
                                        item.Queries.Add(length);
                                        uint readBytes = length.ReturnedBytes > 0 && length.ReturnedBytes <= 65536 ? length.ReturnedBytes : fallbackReadBytes;
                                        item.Queries.Add(Query(control, node, set, selector, Get, readBytes, "GET_CURRENT"));
                                    }
                                }
                                catch (Exception error) { item.Error = error.Message; }
                                finally { Release(nodeObject); }
                            }
                        }
                        catch (Exception error) { device.Error = error.Message; }
                    }
                    finally { Release(filter); Release(storage); Release(moniker); }
                }
                return devices;
            }
            finally { Release(enumerator); Release(enumeratorObject); }
        }
    }
}
