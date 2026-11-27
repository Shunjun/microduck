import { useId, useState } from 'react'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import {
  Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList,
} from '@/components/ui/combobox'

export interface DeviceOption {
  id: string
  label: string
  available: boolean
}

interface DevicePickerProps {
  label: string
  value: string
  onChange: (value: string) => void
  options: DeviceOption[]
  disabled?: boolean
  hint?: string
  placeholder?: string
}

export function DevicePicker({ label, value, onChange, options, disabled, hint, placeholder }: DevicePickerProps) {
  const id = useId()
  const [editing, setEditing] = useState(false)
  const displayValue = options.find((option) => option.id === value)?.label ?? value
  return (
    <Field data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Combobox
        items={options.map((option) => option.id)}
        value={value}
        inputValue={editing ? value : displayValue}
        itemToStringLabel={(device) => options.find((option) => option.id === device)?.label ?? device}
        onInputValueChange={(next, details) => {
          if (details.reason === 'input-change' || details.reason === 'input-clear') {
            setEditing(true)
            onChange(next)
          }
        }}
        onValueChange={(next) => { if (next !== null) { setEditing(false); onChange(next) } }}
        onOpenChange={(open) => { if (!open) setEditing(false) }}
        disabled={disabled}
      >
        <ComboboxInput id={id} required disabled={disabled} onFocus={() => setEditing(true)} triggerLabel={'选择' + label} placeholder={placeholder ?? '选择设备或输入设备标识'} />
        <ComboboxContent>
          <ComboboxEmpty>未检测到匹配设备，可直接输入设备标识</ComboboxEmpty>
          <ComboboxList>
            {(device: string) => {
              const option = options.find((entry) => entry.id === device)
              return (
                <ComboboxItem key={device} value={device}>
                  <span>{option?.label ?? device}</span>
                  {!option?.available && <span className="text-muted-foreground">（未检测到或不可访问）</span>}
                </ComboboxItem>
              )
            }}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  )
}
