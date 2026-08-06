"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
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
import { toast } from "sonner";

export default function LoginPage() {
  const router = useRouter();
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) {
          router.push("/home");
        }
        setIsFirstRun(data.firstRun);
      })
      .catch(() => setIsFirstRun(false));
  }, [router]);

  async function handleLogin() {
    if (!password) return;
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.push("/home");
      } else {
        const data = await res.json();
        toast.error(data.error || "Invalid password");
      }
    } catch {
      toast.error("Connection error");
    } finally {
      setLoading(false);
    }
  }

  async function handleSetup() {
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, setup: true }),
      });
      if (res.ok) {
        router.push("/home");
      } else {
        const data = await res.json();
        toast.error(data.error || "Setup failed");
      }
    } catch {
      toast.error("Connection error");
    } finally {
      setLoading(false);
    }
  }

  if (isFirstRun === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md border border-border shadow-2xl ">
        <CardHeader className="flex flex-col items-center gap-2 pb-0 pt-8">
          <Icon icon="solar:server-bold-duotone" className="text-accent" width={48} />
          <CardTitle className="text-2xl">RunPanel</CardTitle>
          <CardDescription>
            {isFirstRun
              ? "Set up your admin password to get started"
              : "Enter your password to continue"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-5 sm:px-8 pb-6 sm:pb-8 pt-4 sm:pt-6">
          <TextField
            type="password"
            value={password}
            onChange={setPassword}
            autoFocus
          >
            <Label>Password</Label>
            <Input
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isFirstRun) handleLogin();
              }}
            />
          </TextField>

          {isFirstRun && (
            <TextField
              type="password"
              value={confirmPassword}
              onChange={setConfirmPassword}
            >
              <Label>Confirm Password</Label>
              <Input
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSetup();
                }}
              />
            </TextField>
          )}

          <Button
            variant="primary"
            size="lg"
            className="mt-2 w-full"
            isDisabled={loading}
            onPress={isFirstRun ? handleSetup : handleLogin}
          >
            {loading ? <Spinner /> : isFirstRun ? "Create Account" : "Sign In"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
