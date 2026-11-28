import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Expand, RotateCcw } from 'lucide-react'
import { Preview } from '@/lib/preview.js'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { message } from '@/lib/api'
import { useFeedback } from './StudioUI'

interface PoseProps {
  angles?: number[]
  orientation?: number[]
  label: string
  selectedJoint?: number
  children?: ReactNode
}
export function PoseView({ angles, orientation, label, selectedJoint = -1, children }: PoseProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const engine = useRef<Preview | null>(null)
  const [error, setError] = useState('')
  const { act } = useFeedback()
  useEffect(() => {
    const preview = (engine.current = new Preview(canvas.current))
    let live = true
    preview.load().catch((cause: unknown) => {
      if (live) setError(message(cause))
    })
    return () => {
      live = false
      preview.dispose()
      engine.current = null
    }
  }, [])
  useEffect(() => {
    if (angles) engine.current?.pose(angles, orientation)
  }, [angles, orientation])
  useEffect(() => { engine.current?.highlightJoint(selectedJoint) }, [selectedJoint])
  return (
    <div
      ref={surface}
      className="relative isolate min-h-0 flex-1 overflow-hidden rounded-3xl bg-stage"
    >
      <canvas
        ref={canvas}
        className="absolute inset-0 size-full touch-none"
        aria-label="三维姿态，拖动旋转，滚轮缩放"
      />
      <Badge className="absolute left-4 top-4" variant="secondary">
        {label}
      </Badge>
      {error && (
        <p
          role="alert"
          className="absolute inset-x-4 top-1/3 text-center text-sm text-muted-foreground"
        >
          {error}
        </p>
      )}
      {children}
      <div className="pointer-events-none absolute inset-x-4 bottom-4 flex justify-between">
        <Button
          variant="secondary"
          size="sm"
          className="pointer-events-auto"
          onClick={() => engine.current?.reset()}
        >
          <RotateCcw data-icon="inline-start" />
          重置视角
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="pointer-events-auto"
          onClick={() => act(async () => surface.current?.requestFullscreen())}
        >
          <Expand data-icon="inline-start" />
          展开画面
        </Button>
      </div>
    </div>
  )
}
