"use client";

import { Card, CardHeader, CardTitle, CardDescription, CardContent, TextField, Label, Input, Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export default function AccountPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  // Preferences
  const [pollingInterval, setPollingInterval] = useState("5");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [prefsSaving, setPrefsSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then(r => r.json())
      .then((data) => {
        if (data.polling_interval) setPollingInterval(data.polling_interval);
        if (data.timezone) setTimezone(data.timezone);
      }).catch(() => {});
    return () => controller.abort();
  }, []);

  async function handleChangePassword() {
    if (newPassword !== confirmPassword) { toast.error("Passwords do not match"); return; }
    if (newPassword.length < 8) { toast.error("Password must be at least 8 characters"); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword }) });
      if (!res.ok) { const d = await res.json(); toast.error(d.error || "Failed"); return; }
      toast.success("Password changed");
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
    } catch { toast.error("Failed"); }
    finally { setLoading(false); }
  }

  async function handleSavePrefs() {
    setPrefsSaving(true);
    try {
      const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preferences: { polling_interval: pollingInterval, timezone } }) });
      if (res.ok) toast.success("Preferences saved");
      else { const d = await res.json(); toast.error(d.error || "Failed"); }
    } catch { toast.error("Failed"); }
    finally { setPrefsSaving(false); }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Account</h1>
        <p className="text-sm text-foreground-400">Password and preferences</p>
      </div>

      <div className="max-w-xl space-y-6">
        {/* Password */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Icon icon="solar:lock-password-bold-duotone" width={24} className="text-purple-400" />
              <div>
                <CardTitle>Change Password</CardTitle>
                <CardDescription>Update your admin password</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <TextField type="password" value={currentPassword} onChange={setCurrentPassword}><Label>Current Password</Label><Input /></TextField>
            <TextField type="password" value={newPassword} onChange={setNewPassword}><Label>New Password</Label><Input /></TextField>
            <TextField type="password" value={confirmPassword} onChange={setConfirmPassword}><Label>Confirm New Password</Label><Input /></TextField>
            <Button variant="primary" isDisabled={loading} onPress={handleChangePassword}>{loading ? <Spinner /> : "Update Password"}</Button>
          </CardContent>
        </Card>

        {/* Preferences */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Icon icon="solar:settings-bold-duotone" width={24} className="text-purple-400" />
              <div>
                <CardTitle>Preferences</CardTitle>
                <CardDescription>Dashboard settings</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground-400 mb-2">Polling Interval</label>
              <div className="flex gap-2">
                {["2", "5", "10"].map((v) => (
                  <Button key={v} variant={pollingInterval === v ? "primary" : "outline"} size="sm" onPress={() => setPollingInterval(v)}>{v}s</Button>
                ))}
              </div>
              <p className="text-xs text-foreground-500 mt-1">How often to refresh stats and status</p>
            </div>
            <TextField value={timezone} onChange={setTimezone}><Label>Timezone</Label><Input placeholder="Europe/Rome" /></TextField>
            <Button variant="primary" isDisabled={prefsSaving} onPress={handleSavePrefs}>{prefsSaving ? <Spinner /> : "Save Preferences"}</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
