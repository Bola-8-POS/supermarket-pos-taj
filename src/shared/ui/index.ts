/**
 * SHARED UI — BARREL EXPORT (ONLY allowed barrel file in the project)
 *
 * These 18 components are generic, POS-specific UI primitives with NO business entity logic.
 * Do NOT add entity components here (TabCard, ProductCard, PoolTableCard, CartItem, etc.)
 * Entity UI lives in src/entities/<name>/ui/
 */

// Display
export { ChefHatBadge } from './ChefHatBadge';
export { RoutingBadge } from './RoutingBadge';
export { ClockDriftBanner } from './ClockDriftBanner';
export { MoneyDisplay } from './MoneyDisplay';
export type { MoneyDisplayProps } from './MoneyDisplay';
export { TimerDisplay } from './TimerDisplay';
export type { TimerDisplayProps } from './TimerDisplay';
export { LiveTimeDisplay } from './LiveTimeDisplay';
export type { LiveTimeDisplayProps } from './LiveTimeDisplay';
export { StatusBadge } from './StatusBadge';
export type {
  StatusBadgeProps,
  TabOpenDurationBadgeStatus,
  InventoryStockBadgeStatus,
} from './StatusBadge';
export { PrintJobStatusBadge } from './PrintJobStatusBadge';
export type { PrintJobStatusBadgeProps } from './PrintJobStatusBadge';
export { ProtectedAction } from './ProtectedAction';
export type { ProtectedActionProps } from './ProtectedAction';
export { LockedFeature } from './LockedFeature';
export type { LockedFeatureProps } from './LockedFeature';
export { FeatureLockedPage } from './FeatureLockedPage';
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';
export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';
export { SectionHeader } from './SectionHeader';
export type { SectionHeaderProps } from './SectionHeader';
export {
  CardSkeleton,
  TableRowSkeleton,
  ProductGridSkeleton,
  PoolTableGridSkeleton,
  TabListSkeleton,
} from './LoadingSkeletons';
export { LoadingSpinner } from './LoadingSpinner';
export { ErrorBoundary } from './ErrorBoundary';

// Input
export { POSButton } from './POSButton';
export type { POSButtonProps } from './POSButton';
export { QuantityControl } from './QuantityControl';
export type { QuantityControlProps } from './QuantityControl';
export { MoneyInput } from './MoneyInput';
export type { MoneyInputProps } from './MoneyInput';
export { PINKeypad } from './PINKeypad';
export type { PINKeypadProps } from './PINKeypad';
export { FormField } from './FormField';
export type { FormFieldProps } from './FormField';
export { SearchInput } from './SearchInput';
export type { SearchInputProps } from './SearchInput';
export { ConfirmDialog } from './ConfirmDialog';
export type { ConfirmDialogProps } from './ConfirmDialog';
export { UpdateAvailableDialog } from './UpdateAvailableDialog';
export type { UpdateAvailableDialogProps } from './UpdateAvailableDialog';
export { Progress } from './progress';
export { DataTable } from './DataTable';
export type { DataTableProps } from './DataTable';
export { TablePager } from './TablePager';
export type { TablePagerProps } from './TablePager';

// Navigation
export { DateRangePicker } from './DateRangePicker';
export type { DateRangePickerProps } from './DateRangePicker';
export { VerticalTabsList, VerticalTabsGroupLabel, VerticalTabsTrigger } from './vertical-tabs';
export type { VerticalTabsTriggerProps } from './vertical-tabs';

// Layout
export { PageContainer } from './PageContainer';
export type { PageContainerProps } from './PageContainer';
export { SplitLayout } from './SplitLayout';
export type { SplitLayoutProps } from './SplitLayout';
export { ScrollArea } from './ScrollArea';
export type { ScrollAreaProps } from './ScrollArea';

// shadcn primitives
export { Badge, badgeVariants } from './badge';
export type { BadgeProps } from './badge';
export { Button, buttonVariants } from './button';
export type { ButtonProps } from './button';
export { Input } from './input';
export type { InputProps } from './input';
export { Label } from './label';
export { Skeleton } from './skeleton';
export { Alert, AlertTitle, AlertDescription, AlertAction } from './alert';
export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from './alert-dialog';
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from './table';
export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from './sheet';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
export { Switch } from './switch';
export { ScrollAreaRoot, ScrollBar } from './scroll-area';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './select';
export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from './command';
export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from './popover';
export { JsonDiffViewer } from './JsonDiffViewer/JsonDiffViewer';
export type { JsonDiffViewerProps } from './JsonDiffViewer/JsonDiffViewer';
