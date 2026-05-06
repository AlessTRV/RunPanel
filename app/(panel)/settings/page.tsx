"use client";

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  TextField,
  Label,
  Input,
  Button,
  Spinner,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { useState } from "react";
import { toast } from "sonner";

export default function SettingsPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleChangePassword() {
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to change password");
        return;
      }
      toast.success("Password changed successfully");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      toast.error("Failed to change password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-foreground-400">Panel configuration</p>
      </div>

      <div className="max-w-xl space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Icon icon="solar:lock-password-bold-duotone" width={24} className="text-primary" />
              <div>
                <CardTitle>Change Password</CardTitle>
                <CardDescription>Update your admin password</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <TextField type="password" value={currentPassword} onChange={setCurrentPassword}>
              <Label>Current Password</Label>
              <Input />
            </TextField>
            <TextField type="password" value={newPassword} onChange={setNewPassword}>
              <Label>New Password</Label>
              <Input />
            </TextField>
            <TextField type="password" value={confirmPassword} onChange={setConfirmPassword}>
              <Label>Confirm New Password</Label>
              <Input />
            </TextField>
            <Button
              variant="primary"
              isDisabled={loading}
              onPress={handleChangePassword}
            >
              {loading ? <Spinner /> : "Update Password"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
