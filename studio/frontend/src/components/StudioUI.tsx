import {
  createContext,
  useContext,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { CircleAlert } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { message } from '@/lib/api'

export function Duck({ className = 'size-16' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 180 190" aria-hidden="true">
      <ellipse cx="91" cy="170" rx="50" ry="9" fill="#000" opacity=".06" />
      <path
        d="M69 136l-5 27M111 138l6 25"
        stroke="#9a8b70"
        strokeWidth="11"
        strokeLinecap="round"
      />
      <path d="M49 165h31M102 165h32" stroke="#cf8f58" strokeWidth="9" strokeLinecap="round" />
      <path
        d="M49 104q-12 37 24 45 35 10 60-12 12-12-1-36zM74 103L68 67l42-6 7 46"
        fill="#f2cf70"
      />
      <path d="M121 111q27-7 25 15l-19 6" fill="#e6b956" />
      <rect
        x="47"
        y="35"
        width="78"
        height="49"
        rx="20"
        fill="#fbfaf3"
        stroke="#dedbd0"
        strokeWidth="2"
      />
      <rect x="53" y="43" width="65" height="29" rx="11" fill="#323b39" />
      <g fill="#fff6c8">
        <circle cx="73" cy="57" r="5" />
        <circle cx="98" cy="57" r="5" />
      </g>
      <path d="M123 55l19 10-19 7" fill="#dca06c" />
    </svg>
  )
}

export function Heading({
  section,
  title,
  children,
}: {
  section: string
  title: string
  children?: ReactNode
}) {
  return (
    <header className="flex flex-col gap-2">
      <span className="text-[11px] tracking-[.16em] text-muted-foreground">{section}</span>
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {children && <p className="text-sm text-muted-foreground">{children}</p>}
    </header>
  )
}
export function Panel({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
export function Blank({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Empty>
      <EmptyHeader>
        <Duck className="size-24" />
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
export function Problem({ children }: { children: ReactNode }) {
  return children ? (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  ) : null
}
type TextFieldProps = ComponentProps<typeof Input> & { label: string; hint?: string }
export function TextField({ label, hint, ...props }: TextFieldProps) {
  const id = useId()
  return (
    <Field data-disabled={props.disabled || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input {...props} id={id} />
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  )
}
interface ChoiceProps {
  label: string
  value: string
  onChange: (value: string) => void
  options: [string, string][]
  disabled?: boolean
  compact?: boolean
}
export function Choice({ label, value, onChange, options, disabled, compact }: ChoiceProps) {
  const id = useId()
  return (
    <Field data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id} className={compact ? 'sr-only' : undefined}>
        {label}
      </FieldLabel>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} size={compact ? "sm" : "default"} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map(([v, text]) => (
              <SelectItem key={v} value={v}>
                {text}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

interface Feedback {
  notify: (text: string, bad?: boolean) => void
  act: (task: () => Promise<unknown>, success?: string) => Promise<boolean>
  confirm: (title: string, detail: string) => Promise<boolean>
}
const FeedbackContext = createContext<Feedback | null>(null)
export const useFeedback = () => useContext(FeedbackContext)!
interface Confirmation {
  title: string
  detail: string
  resolve: (value: boolean) => void
}
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<Confirmation | null>(null)
  const notify = (text: string, bad = false) => {
    if (bad) toast.error(text)
    else toast.success(text)
  }
  const confirm = (title: string, detail: string) =>
    new Promise<boolean>((resolve) => setDialog({ title, detail, resolve }))
  function close(ok: boolean) {
    dialog?.resolve(ok)
    setDialog(null)
  }
  async function act(task: () => Promise<unknown>, success?: string) {
    try {
      await task()
      if (success) notify(success)
      return true
    } catch (error) {
      notify(message(error), true)
      return false
    }
  }
  return (
    <FeedbackContext.Provider value={{ notify, act, confirm }}>
      {children}
      <Toaster theme="light" position="bottom-center" closeButton />
      <AlertDialog
        open={!!dialog}
        onOpenChange={(v) => {
          if (!v && dialog) close(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialog?.title}</AlertDialogTitle>
            <AlertDialogDescription>{dialog?.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => close(false)}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => close(true)}>确认</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FeedbackContext.Provider>
  )
}
