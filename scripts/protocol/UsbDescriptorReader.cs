// Read-only USB hub descriptor inspection. No camera settings or vendor requests.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Caloraview.Protocol {
    public sealed class UsbDescriptorResult {
        public string HubPath;
        public uint Port;
        public byte[] Configuration;
    }
    public static class UsbDescriptorReader {
        [StructLayout(LayoutKind.Sequential)]
        struct DeviceInterface {
            public int Size;
            public Guid ClassGuid;
            public uint Flags;
            public UIntPtr Reserved;
        }
        [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr SetupDiGetClassDevs(ref Guid guid, IntPtr enumerator, IntPtr hwnd, uint flags);
        [DllImport("setupapi.dll", SetLastError=true)]
        static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr device, ref Guid guid, uint index, ref DeviceInterface item);
        [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref DeviceInterface item, IntPtr detail, uint size, out uint required, IntPtr device);
        [DllImport("setupapi.dll")]
        static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, uint inputSize, byte[] output, uint outputSize, out uint returned, IntPtr overlapped);

        // IOCTL_USB_GET_NODE_INFORMATION, _NODE_CONNECTION_INFORMATION_EX, and
        // _DESCRIPTOR_FROM_NODE_CONNECTION are the only allowed requests.
        static byte[] Query(SafeFileHandle handle, uint code, byte[] buffer) {
            if (code != 0x220408 && code != 0x220448 && code != 0x220410)
                throw new ArgumentException("Only descriptor and connection reads are permitted.");
            uint received;
            if (!DeviceIoControl(handle, code, buffer, (uint)buffer.Length, buffer, (uint)buffer.Length, out received, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (received > buffer.Length) throw new InvalidOperationException("Invalid USB response size.");
            Array.Resize(ref buffer, (int)received);
            return buffer;
        }
        static void U32(byte[] b, int p, uint value) { Array.Copy(BitConverter.GetBytes(value), 0, b, p, 4); }
        static byte[] Configuration(SafeFileHandle hub, uint port) {
            // USB_DESCRIPTOR_REQUEST has a 12-byte prefix. Allocate the full
            // possible descriptor length so multi-interface configurations fit.
            byte[] request = new byte[12 + 65535];
            U32(request, 0, port);
            request[4] = 0x80; request[5] = 6; // GET_DESCRIPTOR, device-to-host
            request[7] = 2; // configuration descriptor, index 0
            request[10] = 255; request[11] = 255;
            byte[] response = Query(hub, 0x220410, request);
            if (response.Length < 21 || response[12] < 9 || response[13] != 2)
                throw new InvalidOperationException("Missing configuration descriptor.");
            int length = BitConverter.ToUInt16(response, 14);
            if (length < 9 || length > response.Length - 12)
                throw new InvalidOperationException("Truncated configuration descriptor.");
            byte[] descriptor = new byte[length];
            Array.Copy(response, 12, descriptor, 0, length);
            return descriptor;
        }
        public static UsbDescriptorResult[] Read(ushort vendor, ushort product) {
            var results = new List<UsbDescriptorResult>();
            Guid guid = new Guid("f18a0e88-c30c-11d0-8815-00a0c906bed8");
            IntPtr set = SetupDiGetClassDevs(ref guid, IntPtr.Zero, IntPtr.Zero, 0x12);
            if (set == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                for (uint index = 0; ; ++index) {
                    DeviceInterface item = new DeviceInterface();
                    item.Size = Marshal.SizeOf(typeof(DeviceInterface));
                    if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref guid, index, ref item)) {
                        int error = Marshal.GetLastWin32Error();
                        if (error == 259) break;
                        throw new Win32Exception(error);
                    }
                    uint required;
                    SetupDiGetDeviceInterfaceDetail(set, ref item, IntPtr.Zero, 0, out required, IntPtr.Zero);
                    IntPtr detail = Marshal.AllocHGlobal((int)required);
                    string path;
                    try {
                        Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 6);
                        if (!SetupDiGetDeviceInterfaceDetail(set, ref item, detail, required, out required, IntPtr.Zero))
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        path = Marshal.PtrToStringUni(IntPtr.Add(detail, 4));
                    } finally { Marshal.FreeHGlobal(detail); }
                    // Zero desired access is sufficient for FILE_ANY_ACCESS IOCTLs.
                    using (SafeFileHandle hub = CreateFile(path, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
                        if (hub.IsInvalid) { Console.Error.WriteLine("Hub open failed: " + Marshal.GetLastWin32Error()); continue; }
                        byte[] hubInfo;
                        try { hubInfo = Query(hub, 0x220408, new byte[76]); }
                        catch (Win32Exception e) { Console.Error.WriteLine("Hub information failed: " + e.NativeErrorCode); continue; }
                        if (hubInfo.Length < 7) continue;
                        uint ports = hubInfo[6];
                        for (uint port = 1; port <= ports; ++port) {
                            byte[] connection = new byte[4096];
                            U32(connection, 0, port);
                            try { connection = Query(hub, 0x220448, connection); }
                            catch (Win32Exception) { continue; }
                            // Packed USB_NODE_CONNECTION_INFORMATION_EX: descriptor
                            // starts at4; VID/PID at12/14; connection status at31.
                            // usbioctl.h uses byte packing, including DeviceAddress.
                            if (connection.Length < 35 || BitConverter.ToUInt32(connection, 31) != 1) continue;
                            if (BitConverter.ToUInt16(connection, 12) != vendor || BitConverter.ToUInt16(connection, 14) != product) continue;
                            results.Add(new UsbDescriptorResult { HubPath=path, Port=port, Configuration=Configuration(hub, port) });
                        }
                    }
                }
            } finally { SetupDiDestroyDeviceInfoList(set); }
            return results.ToArray();
        }
    }
}
