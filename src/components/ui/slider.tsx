import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from '../../lib/utils';

const Slider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('relative flex w-full touch-none select-none items-center', className)}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-[rgba(168,191,217,0.15)]">
      <SliderPrimitive.Range className="absolute h-full bg-[#3f7ad8]" />
    </SliderPrimitive.Track>
    {children}
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

const SliderThumb = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Thumb>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Thumb>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Thumb
    ref={ref}
    className={cn(
      'block h-4 w-4 rounded-full border-2 border-[#3f7ad8] bg-[#0a1628] shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3f7ad8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a1628] disabled:pointer-events-none disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
SliderThumb.displayName = SliderPrimitive.Thumb.displayName;

export { Slider, SliderThumb };
