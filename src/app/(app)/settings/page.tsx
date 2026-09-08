import { SettingsView } from "@/components/settings/settings-view";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { getMyProfileSettings } from "@/lib/db/team";
import { parseNotifyPrefs } from "@/lib/dialer/notify-prefs";
import { parseDialerUserPrefs } from "@/lib/dialer/user-prefs";
import { getViewer } from "@/lib/org/membership";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [viewer, profile] = await Promise.all([getViewer(), getMyProfileSettings()]);

  return (
    <PageContainer>
      <PageHeader
        title="Settings"
        description="Manage your profile, access, appearance, and dialing preferences."
      />
      <SettingsView
        account={{ name: viewer.displayName, email: viewer.email }}
        role={viewer.role}
        orgName={viewer.org?.name ?? null}
        productName={viewer.org?.productName || null}
        membershipStatus={viewer.membershipStatus}
        permissions={viewer.permissions}
        team={profile.team}
        dialerPrefs={parseDialerUserPrefs(profile.preferences)}
        notifyPrefs={parseNotifyPrefs(profile.preferences)}
      />
    </PageContainer>
  );
}
