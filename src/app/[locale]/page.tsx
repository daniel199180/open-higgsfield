import { StudioShell } from "@/components/studio/StudioShell";
import { COOKIE_NAME, isAdminConfigured, verifyAdminSession } from "@/lib/admin-auth";
import { cookies } from "next/headers";

export default async function StudioPage() {
    const cookieStore = await cookies();
    const [configured, authenticated] = await Promise.all([
        isAdminConfigured(),
        verifyAdminSession(cookieStore.get(COOKIE_NAME)?.value),
    ]);
    return <StudioShell initialAdminConfigured={configured} initialAuthenticated={authenticated} />;
}
