import { useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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

/**
 * Trash-icon button that confirms before deleting. Several destructive actions
 * across the app (bills, expenses, snack sales, turf bookings) used to fire a
 * single-tap delete straight to the mutation with no way back, inconsistent
 * with the AlertDialog-gated deletes elsewhere (customers, backups, archive).
 * This centralizes that confirmation so every delete goes through the same gate.
 */
export function ConfirmDeleteButton({
  title,
  description,
  onConfirm,
  ariaLabel,
  size = "icon",
  className,
  iconClassName = "h-4 w-4",
  disabled,
}: {
  title: string;
  description: ReactNode;
  onConfirm: () => void;
  ariaLabel: string;
  size?: "icon" | "sm" | "default" | "touch";
  className?: string;
  iconClassName?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size={size}
        className={className}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Trash2 className={iconClassName} />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setOpen(false);
                onConfirm();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
