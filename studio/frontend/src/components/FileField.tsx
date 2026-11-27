import { useId, useRef, useState } from 'react'
import { FileUp } from 'lucide-react'
import { Button } from './ui/button'
import { Field, FieldDescription, FieldLabel } from './ui/field'

interface FileFieldProps {
  label: string
  accept: string
  hint: string
  maxBytes: number
  disabled?: boolean
  onChange: (file: File | null) => void
}

export function FileField({ label, accept, hint, maxBytes, disabled, onChange }: FileFieldProps) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const size = file ? file.size >= 1048576 ? (file.size / 1048576).toFixed(2) + ' MiB' : (file.size / 1024).toFixed(1) + ' KiB' : ''
  return (
    <Field data-disabled={disabled || undefined} data-invalid={!!error || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input ref={input} type="file" accept={accept} disabled={disabled} className="sr-only" tabIndex={-1} aria-label={label + '文件'} onChange={(event) => {
        const next = event.target.files?.[0]
        if (!next) return
        const invalid = next.size === 0 ? '文件不能为空。' : next.size > maxBytes ? '文件超出大小限制，请重新选择。' : ''
        setFile(next)
        setError(invalid)
        onChange(invalid ? null : next)
        event.target.value = ''
      }} />
      <Button id={id} type="button" variant="outline" className="w-full justify-start" disabled={disabled} aria-invalid={!!error || undefined} aria-describedby={id + '-hint'} onClick={() => input.current?.click()}>
        <FileUp data-icon="inline-start" />
        {file ? '重新选择' : '选择文件'}
      </Button>
      <p className="truncate text-xs text-muted-foreground" title={file?.name} aria-live="polite">{file ? file.name + ' · ' + size : '未选择文件'}</p>
      <FieldDescription id={id + '-hint'}>{error || hint}</FieldDescription>
    </Field>
  )
}
