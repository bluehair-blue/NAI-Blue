import { ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface ConfirmDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    description?: ReactNode
    confirmText?: string
    cancelText?: string
    variant?: 'default' | 'destructive'
    busy?: boolean
    onConfirm: () => void | Promise<void>
}

export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmText = '확인',
    cancelText = '취소',
    variant = 'default',
    busy = false,
    onConfirm,
}: ConfirmDialogProps) {
    const handleConfirm = async () => {
        if (busy) return
        try {
            await onConfirm()
            onOpenChange(false)
        } catch {
            // The caller owns the user-facing error; a failed command keeps this dialog open.
        }
    }

    return (
        <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
            <DialogContent className="max-w-sm" aria-busy={busy}>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        {variant === 'destructive' && <AlertTriangle className="h-4 w-4 text-destructive" />}
                        {title}
                    </DialogTitle>
                    {description && (
                        <DialogDescription className="pt-1 whitespace-pre-wrap">{description}</DialogDescription>
                    )}
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                        {cancelText}
                    </Button>
                    <Button
                        variant={variant === 'destructive' ? 'destructive' : 'default'}
                        onClick={handleConfirm}
                        disabled={busy}
                    >
                        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {confirmText}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
