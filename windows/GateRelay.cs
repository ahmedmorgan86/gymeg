using System;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace GymOS.Windows;

/// <summary>
/// Dispatches turnstile / door relay open pulses strictly to private LAN or loopback endpoints.
/// </summary>
public static class GateRelay {
  private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMilliseconds(3000) };

  public static bool IsPrivateLanHost(string host) {
    if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)) return true;
    if (!IPAddress.TryParse(host, out var ip)) return false;
    if (IPAddress.IsLoopback(ip)) return true;
    var b = ip.GetAddressBytes();
    if (b.Length != 4) return false;
    if (b[0] == 10) return true;
    if (b[0] == 192 && b[1] == 168) return true;
    if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return true;
    return false;
  }

  public static async Task<(bool Ok, string Detail)> OpenAsync(string protocol, string endpoint, int pulseMs) {
    if (string.IsNullOrWhiteSpace(endpoint)) return (false, "Empty endpoint");
    var clampedMs = Math.Clamp(pulseMs, 200, 10000);

    if (protocol == "http-relay") {
      if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) ||
          (uri.Scheme != "http" && uri.Scheme != "https") ||
          !IsPrivateLanHost(uri.Host)) {
        return (false, "Only private LAN or localhost HTTP relay endpoints are allowed");
      }
      var payload = JsonSerializer.Serialize(new { action = "open", pulseMs = clampedMs });
      using var content = new StringContent(payload, Encoding.UTF8, "application/json");
      using var resp = await Http.PostAsync(uri, content);
      return (resp.IsSuccessStatusCode, $"HTTP {(int)resp.StatusCode}");
    }

    var parts = endpoint.Trim().Split(':');
    var host = parts[0];
    var port = parts.Length > 1 && int.TryParse(parts[1], out var p) ? p : 4370;
    if (!IsPrivateLanHost(host) || port < 1 || port > 65535) {
      return (false, "Only private LAN host:port endpoints are allowed");
    }
    using var client = new TcpClient();
    await client.ConnectAsync(host, port).WaitAsync(TimeSpan.FromMilliseconds(3000));
    var cmd = Encoding.ASCII.GetBytes($"OPEN:{clampedMs}\n");
    await client.GetStream().WriteAsync(cmd);
    return (true, $"TCP {host}:{port}");
  }
}
