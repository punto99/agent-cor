import { AlertCircle, CheckCircle2, X } from "lucide-react";
import type { ControlPanelToastState } from "./types";

type ControlPanelToastProps = {
  toast: ControlPanelToastState;
  onClose: () => void;
};

export function ControlPanelToast({ toast, onClose }: ControlPanelToastProps) {
  return (
    <div className="fixed bottom-6 right-6 z-[60] animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div
        className={`flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border ${
          toast.type === "success"
            ? "bg-emerald-50 dark:bg-emerald-950/80 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200"
            : "bg-red-50 dark:bg-red-950/80 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200"
        }`}
      >
        {toast.type === "success" ? (
          <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
        ) : (
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
        )}
        <p className="text-sm font-medium">{toast.message}</p>
        <button
          onClick={onClose}
          className="ml-2 cursor-pointer rounded p-1 transition-colors hover:bg-black/10 dark:hover:bg-white/10"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
