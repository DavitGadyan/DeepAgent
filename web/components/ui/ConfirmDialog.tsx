'use client';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

interface ConfirmText {
  title: string;
  confirmLabel: string;
  /** What happens if the user confirms. */
  children: ReactNode;
}

/** Modal confirmation on the native <dialog>; Escape and the Cancel button both cancel. */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  onConfirm,
  onCancel,
  children,
}: ConfirmText & {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog ref={dialog} className="dialog" aria-labelledby={titleId} onClose={onCancel}>
      <h2 id={titleId} className="text-base font-bold text-fg">
        {title}
      </h2>
      <div className="mt-3 grid gap-2 text-[0.84rem] leading-relaxed text-soft">{children}</div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

/** A button that asks for confirmation before it calls `onConfirm`. */
export function ConfirmButton({
  label,
  className,
  disabled,
  onConfirm,
  ...text
}: ConfirmText & {
  label: string;
  className: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </button>
      <ConfirmDialog
        {...text}
        open={open}
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          onConfirm();
        }}
      />
    </>
  );
}
