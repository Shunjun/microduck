import * as React from "react"
import { cn } from "cn"

interface InputProps extends React.ComponentProps<"input"> {
  density?: "default" | "compact"
}

function Input({ className, type, density = "default", ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      data-density={density}
      className={cn(
        "h-(--control-height-md) data-[density=compact]:h-(--control-height-sm) w-full min-w-0 rounded-md border border-input bg-secondary px-[11px] py-1.5 data-[density=compact]:py-1 text-[13px] leading-5 transition-colors outline-none file:inline-flex file:h-(--control-height-xs) file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
