"use client";

import { RouterProvider } from "@heroui/react";
import { useRouter } from "next/navigation";
import { Toaster } from "sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  return (
    <RouterProvider navigate={router.push}>
      {children}
      <Toaster theme="dark" position="bottom-right" richColors />
    </RouterProvider>
  );
}
