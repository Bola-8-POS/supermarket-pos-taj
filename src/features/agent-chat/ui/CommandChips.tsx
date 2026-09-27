import { Button } from '@shared/ui/button';

interface CommandChipsProps {
  onSelect: (text: string) => void;
  userRole: string;
}

const CHIPS_BY_ROLE: Record<string, string[]> = {
  bartender: ['Ver menú', 'Ventas de hoy', 'Agregar producto'],
  cashier: ['Ver menú', 'Ventas de hoy', 'Agregar producto'],
  manager: ['Reporte de hoy', 'Diagnóstico', 'Ver errores recientes', '¿Cuántos productos hay?'],
  admin: ['Reporte de hoy', 'Diagnóstico', 'Ver errores recientes', '¿Cuántos productos hay?'],
};

function getChipsForRole(role: string): string[] {
  return CHIPS_BY_ROLE[role] ?? CHIPS_BY_ROLE['bartender'] ?? [];
}

export function CommandChips({ onSelect, userRole }: CommandChipsProps) {
  const chips = getChipsForRole(userRole);

  return (
    <div className="flex flex-wrap gap-2 px-3 py-2">
      {chips.map(chip => (
        <Button
          key={chip}
          type="button"
          variant="outline"
          onClick={() => {
            onSelect(chip);
          }}
          className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-xs transition-colors hover:border-brand/50 hover:bg-brand-soft hover:text-brand-strong"
        >
          {chip}
        </Button>
      ))}
    </div>
  );
}
