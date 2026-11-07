// Pure managed fake transport: this executable never enumerates or opens USB.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using Caloraview.Protocol;

internal sealed class FakeKsControl : IKsControl
{
    internal byte[] State = new byte[186];
    internal List<byte[]> Writes = new List<byte[]>();
    internal List<byte[]> Selects = new List<byte[]>();
    internal bool FailReads;
    internal FakeKsControl()
    {
        for (int i = 0; i < State.Length; i++) State[i] = (byte)(i * 17 % 251);
        State[0] = 1;
    }
    public int KsProperty(ref KsNodeProperty property, uint propertyLength, IntPtr data, uint length, out uint returned)
    {
        Check.That(propertyLength == 32, "KSP_NODE length");
        Check.That(property.NodeId == 2, "correct KS topology node");
        Check.That(property.Set == new Guid("a29e7641-de04-47e3-8b2b-f4341aff003b"), "extension GUID");
        Check.That((property.Flags & 0x10000000) != 0, "TOPOLOGY flag");
        returned = 0;
        if ((property.Flags & 2) != 0)
        {
            byte[] bytes = new byte[length];
            Marshal.Copy(data, bytes, 0, bytes.Length);
            if (property.Id == 5) { Selects.Add(bytes); return 0; }
            Check.That(property.Id == 2, "only image-enhancement payload is written");
            Check.That(length == State.Length, "preserve current firmware payload length");
            Writes.Add(bytes); State = bytes;
            return 0;
        }
        Check.That((property.Flags & 1) != 0, "GET flag");
        if (property.Id == 6) { Marshal.WriteByte(data, 0); returned = 1; return 0; }
        Check.That(property.Id == 2, "expected read selector");
        if (FailReads) return unchecked((int)0x80004005);
        returned = (uint)State.Length;
        if (length == 0) return unchecked((int)0x800700ea);
        Marshal.Copy(State, 0, data, State.Length);
        return 0;
    }
    public int KsMethod(IntPtr m, uint ml, IntPtr d, uint dl, out uint returned) { returned = 0; throw new Exception("No KS methods allowed"); }
    public int KsEvent(IntPtr m, uint ml, IntPtr d, uint dl, out uint returned) { returned = 0; throw new Exception("No KS events allowed"); }
}

internal static class Check
{
    internal static void That(bool condition, string description) { if (!condition) throw new Exception(description); }
    private static object Call(string name, params object[] arguments)
    {
        return typeof(KsCameraControl).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, arguments);
    }
    private static void ChangesOnlyShutter(byte[] original, byte[] actual, byte mode)
    {
        That(original.Length == actual.Length, "payload shape preserved");
        for (int i = 0; i < original.Length; i++) That(actual[i] == (i == 0x2f ? mode : original[i]), "only shutter byte may change at " + i);
    }
    public static int Main()
    {
        try
        {
            That(Marshal.SizeOf(typeof(KsNodeProperty)) == 32, "KSP_NODE structure must be32bytes");
            That(Marshal.OffsetOf(typeof(KsNodeProperty), "Id").ToInt32() == 16, "property ID offset");
            That(Marshal.OffsetOf(typeof(KsNodeProperty), "Flags").ToInt32() == 20, "flags offset");
            That(Marshal.OffsetOf(typeof(KsNodeProperty), "NodeId").ToInt32() == 24, "node offset");
            var guid = new Guid("a29e7641-de04-47e3-8b2b-f4341aff003b");
            That(BitConverter.ToString(guid.ToByteArray()) == "41-76-9E-A2-04-DE-E3-47-8B-2B-F4-34-1A-FF-00-3B", "GUID wire ordering");
            var fake = new FakeKsControl();
            var queries = new List<KsQueryResult>();
            byte[] baseline = (byte[])fake.State.Clone();
            Call("ShutterMode", fake, (uint)2, guid, (byte)2, queries, null);
            That(fake.Writes.Count == 1, "one shutter SET");
            ChangesOnlyShutter(baseline, fake.Writes[0], 2);
            That(BitConverter.ToString(fake.Selects[0]) == "02-05-01-00", "exact read/write selection envelope");

            fake.FailReads = true;
            Call("ShutterMode", fake, (uint)2, guid, (byte)3, queries, baseline);
            ChangesOnlyShutter(baseline, fake.Writes[1], 3);
            That(queries.Exists(q => q.Operation == "RECOVERY_USING_PRESERVED_PAYLOAD"), "read failure must use preserved recovery payload");

            bool invalidModeRejected = false;
            try { Call("ShutterMode", fake, (uint)2, guid, (byte)9, queries, baseline); }
            catch (TargetInvocationException e) { invalidModeRejected = e.InnerException is InvalidOperationException; }
            That(invalidModeRejected && fake.Writes.Count == 2, "invalid actuator mode rejected before write");

            bool unsafeSelectionRejected = false;
            try { Call("SelectRead", fake, (uint)2, guid, new byte[] { 26, 9, 1, 0 }); }
            catch (TargetInvocationException e) { unsafeSelectionRejected = e.InnerException is InvalidOperationException; }
            That(unsafeSelectionRejected, "unknown command selection rejected");

            var cycle = new FakeKsControl();
            byte[] beforeCycle = (byte[])cycle.State.Clone();
            var stages = new List<string>();
            Action<string> callback = delegate(string stage) { stages.Add(stage); if (stage == "closed") throw new Exception("Simulated host capture failure"); };
            bool captureFailureSeen = false;
            try { Call("NormalShutterCycle", cycle, (uint)2, guid, 500, new List<KsQueryResult>(), callback); }
            catch (TargetInvocationException e) { captureFailureSeen = e.InnerException.Message.Contains("Simulated host capture failure"); }
            That(captureFailureSeen, "original host failure returned");
            That(cycle.Writes.Count == 4, "failed host capture still performs up and release");
            byte[] modes = { 2, 1, 3, 1 };
            for (int i = 0; i < modes.Length; i++) ChangesOnlyShutter(beforeCycle, cycle.Writes[i], modes[i]);
            That(String.Join(",", stages) == "closed,opening,opened", "recovery stages must identify reopening");
            Console.WriteLine("PASS: KS layout, exact selector envelope, preserved payload, mode allowlist, and shutter recovery.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.ToString()); return 1; }
    }
}
