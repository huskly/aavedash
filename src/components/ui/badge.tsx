import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from '../../lib/utils';

export type BadgeVariant = 'default' | 'positive' | 'warning' | 'destructive';

const badgeVariants = cva(
  'inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-secondary text-secondary-foreground',
        positive: 'bg-positive/15 text-positive border border-positive/25',
        warning: 'bg-warning/15 text-warning border border-warning/25',
        destructive: 'bg-destructive/15 text-destructive border border-destructive/25',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'span'> & { variant?: BadgeVariant }) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge };
