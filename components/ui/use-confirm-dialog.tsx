"use client";

import { useCallback, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type DialogBase = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

type DialogRequest = DialogBase & {
  input?: boolean;
  defaultValue?: string;
  inputLabel?: string;
  resolve: (value: boolean | string | null) => void;
};

const CANCEL = "إلغاء / Cancel";
const CONFIRM = "تأكيد / Confirm";

/** Promise-based accessible replacement for window.confirm/window.prompt. */
export function useConfirmDialog() {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState("");
  const pending = useRef<DialogRequest | null>(null);

  const open = useCallback((config: Omit<DialogRequest, "resolve">) => {
    pending.current?.resolve(null);
    pending.current = null;
    return new Promise<boolean | string | null>((resolve) => {
      const next: DialogRequest = { ...config, resolve };
      pending.current = next;
      setRequest(next);
      setValue(config.defaultValue ?? "");
    });
  }, []);

  const confirm = useCallback(
    async (config: DialogBase) => (await open(config)) === true,
    [open]
  );

  const prompt = useCallback(
    async (config: DialogBase & { defaultValue?: string; inputLabel?: string }) => {
      const answer = await open({ ...config, input: true });
      return typeof answer === "string" && answer.trim() ? answer.trim() : null;
    },
    [open]
  );

  const finish = useCallback((result: boolean | string | null) => {
    const current = pending.current;
    pending.current = null;
    setRequest(null);
    current?.resolve(result);
  }, []);

  const accept = useCallback(() => {
    if (!request) return;
    if (request.input) {
      const answer = value.trim();
      finish(answer || null);
    } else {
      finish(true);
    }
  }, [finish, request, value]);

  const dialog = request ? (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next) finish(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
          {request.description ? (
            <AlertDialogDescription>{request.description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        {request.input ? (
          <label>
            {request.inputLabel ?? request.title}
            <input
              autoFocus
              dir="auto"
              value={value}
              maxLength={500}
              aria-label={request.inputLabel ?? request.title}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => finish(null)}>
            {request.cancelLabel ?? CANCEL}
          </AlertDialogCancel>
          <AlertDialogAction onClick={accept} disabled={request.input && !value.trim()}>
            {request.confirmLabel ?? CONFIRM}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : null;

  return { confirm, prompt, dialog };
}
