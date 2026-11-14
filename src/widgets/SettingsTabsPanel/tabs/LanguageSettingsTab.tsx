import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useMutationSetOwnLocale } from '@entities/staff/model/queries';
import { useStaffStore } from '@entities/staff/model/store';
import { LocaleSchema, type Locale } from '@shared/lib/domain';
import i18n from '@shared/lib/i18n';
import {
  Label,
  POSButton,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@shared/ui';
import { useRegisterUnsavedChanges } from '../model/unsaved-changes';

const LOCALE_OPTIONS = LocaleSchema.options;

/**
 * Self-service locale switcher (D-03) — deliberately ungated by role.
 * Every authenticated role, including bartender, must be able to change
 * their own UI language.
 */
export function LanguageSettingsTab() {
  const { t } = useTranslation('settings');
  const currentStaff = useStaffStore(s => s.currentStaff);
  const mutation = useMutationSetOwnLocale();

  // ponytail: no hydration useEffect — LanguageSettingsTab only ever renders
  // behind ProtectedRoute, so currentStaff is already populated at mount.
  const [locale, setLocale] = useState<Locale>(currentStaff?.locale ?? 'es-MX');
  const [dirty, setDirty] = useState(false);

  const save = useCallback(async (): Promise<boolean> => {
    const result = await mutation.mutateAsync({ locale });
    if (!result.ok) {
      toast.error(t('language.saveError'));
      return false;
    }
    // Switch on success only — avoids a half-saved state if the write fails
    // (UI-SPEC.md Interaction Contract step 2).
    void i18n.changeLanguage(locale);
    toast.success(t('language.saveSuccess'));
    setDirty(false);
    return true;
  }, [locale, mutation, t]);

  useRegisterUnsavedChanges(dirty, save);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">{t('language.heading')}</h2>
      <div className="space-y-2">
        <Label htmlFor="settings-language">{t('language.fieldLabel')}</Label>
        <Select
          value={locale}
          onValueChange={value => {
            const parsed = LocaleSchema.safeParse(value);
            if (!parsed.success) return;
            setLocale(parsed.data);
            setDirty(true);
          }}
        >
          <SelectTrigger id="settings-language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {LOCALE_OPTIONS.map(option => (
                <SelectItem key={option} value={option}>
                  {option === 'es-MX' ? t('language.option.esMX') : t('language.option.enUS')}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">{t('language.helper')}</p>
      </div>
      <POSButton
        type="button"
        touchSize="large"
        disabled={!dirty || mutation.isPending}
        onClick={() => {
          void save();
        }}
      >
        {mutation.isPending ? t('language.saving') : t('language.save')}
      </POSButton>
    </div>
  );
}
