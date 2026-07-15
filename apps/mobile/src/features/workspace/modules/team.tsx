import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { api, type MobileMembership } from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import { PAGE_SIZE, parseRequiredNumber, useGenericError, PrimaryButton, FormField, SelectField, FormModal, RecordCard, ModuleList } from "./moduleShared";
import { styles } from "./moduleStyles";

export function TeamModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const addMember = useMutation(api.memberships.add);
  const createAccount = useAction(api.memberships.createAccount);
  const updateRole = useMutation(api.memberships.updateRole);
  const updateCommissionRate = useMutation(api.memberships.updateCommissionRate);
  const { loadMore, results, status } = usePaginatedQuery(api.memberships.list, { orgId }, { initialNumItems: PAGE_SIZE });
  const roles = useQuery(api.roles.list, { orgId });
  const roleOptions = (roles ?? []).map((role) => ({ label: role.name, value: role._id }));
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<MobileMembership | null>(null);
  const [saving, setSaving] = useState(false);
  const [inviteForm, setInviteForm] = useState({
    email: "",
    firstName: "",
    lastName: "",
    roleId: "",
    createDirectAccount: "false",
  });
  const [memberForm, setMemberForm] = useState({
    roleId: "",
    commissionRate: "0",
  });

  function openInvite() {
    setInviteForm({
      email: "",
      firstName: "",
      lastName: "",
      roleId: roleOptions[0]?.value ?? "",
      createDirectAccount: "false",
    });
    setInviteOpen(true);
  }

  function openMember(member: MobileMembership) {
    setEditing(member);
    setMemberForm({
      roleId: member.roleId,
      commissionRate: String(member.commissionRate ?? 0),
    });
  }

  async function saveInvite() {
    if (!inviteForm.email.trim() || !inviteForm.roleId) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    setSaving(true);
    try {
      if (inviteForm.createDirectAccount === "true") {
        if (!inviteForm.firstName.trim() || !inviteForm.lastName.trim()) {
          Alert.alert(locale === "ar" ? "الاسم مطلوب" : "Name required");
          return;
        }
        await createAccount({
          orgId,
          email: inviteForm.email,
          firstName: inviteForm.firstName,
          lastName: inviteForm.lastName,
          roleId: inviteForm.roleId,
        });
      } else {
        await addMember({ orgId, userEmail: inviteForm.email, roleId: inviteForm.roleId });
      }
      setInviteOpen(false);
    } catch (error) {
      reportError("Mobile team invite failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function saveMember() {
    if (!editing || !memberForm.roleId) return;
    const commissionRate = parseRequiredNumber(memberForm.commissionRate);
    if (commissionRate === null || commissionRate < 0 || commissionRate > 100) {
      Alert.alert(locale === "ar" ? "نسبة غير صالحة" : "Invalid commission");
      return;
    }
    setSaving(true);
    try {
      if (memberForm.roleId !== editing.roleId) {
        await updateRole({ orgId, membershipId: editing._id, newRoleId: memberForm.roleId });
      }
      if (commissionRate !== (editing.commissionRate ?? 0)) {
        await updateCommissionRate({ orgId, membershipId: editing._id, commissionRate });
      }
      setEditing(null);
    } catch (error) {
      reportError("Mobile team member update failed", error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <ModuleList
        data={results}
        emptyLabel={locale === "ar" ? "لا يوجد أعضاء." : "No team members found."}
        keyExtractor={(member) => member._id}
        loadMore={loadMore}
        status={status}
        header={
          <View style={styles.actionRow}>
            <PrimaryButton label={locale === "ar" ? "إضافة عضو" : "Add member"} onPress={openInvite} />
          </View>
        }
        renderItem={(member: MobileMembership) => (
          <RecordCard>
            <Text style={styles.recordTitle}>{member.userName}</Text>
            <Text style={styles.recordMeta}>{member.userEmail}</Text>
            <Text style={styles.recordMeta}>{member.roleName} · {member.commissionRate}%</Text>
            <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openMember(member)} />
          </RecordCard>
        )}
      />
      <FormModal
        title={locale === "ar" ? "إضافة عضو" : "Add member"}
        visible={inviteOpen}
        onClose={() => setInviteOpen(false)}
      >
        <FormField keyboardType="email-address" label={locale === "ar" ? "البريد" : "Email"} value={inviteForm.email} onChangeText={(email) => setInviteForm((prev) => ({ ...prev, email }))} />
        <SelectField label={locale === "ar" ? "الدور" : "Role"} value={inviteForm.roleId} options={roleOptions} onChange={(roleId) => setInviteForm((prev) => ({ ...prev, roleId }))} />
        <SelectField
          label={locale === "ar" ? "الطريقة" : "Mode"}
          value={inviteForm.createDirectAccount}
          options={[
            { label: locale === "ar" ? "دعوة بالبريد" : "Email invite", value: "false" },
            { label: locale === "ar" ? "إنشاء حساب" : "Create account", value: "true" },
          ]}
          onChange={(createDirectAccount) => setInviteForm((prev) => ({ ...prev, createDirectAccount }))}
        />
        {inviteForm.createDirectAccount === "true" ? (
          <>
            <FormField label={locale === "ar" ? "الاسم الأول" : "First name"} value={inviteForm.firstName} onChangeText={(firstName) => setInviteForm((prev) => ({ ...prev, firstName }))} />
            <FormField label={locale === "ar" ? "اسم العائلة" : "Last name"} value={inviteForm.lastName} onChangeText={(lastName) => setInviteForm((prev) => ({ ...prev, lastName }))} />
          </>
        ) : null}
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={saveInvite} />
      </FormModal>
      <FormModal
        title={locale === "ar" ? "تعديل عضو" : "Edit member"}
        visible={Boolean(editing)}
        onClose={() => setEditing(null)}
      >
        <SelectField label={locale === "ar" ? "الدور" : "Role"} value={memberForm.roleId} options={roleOptions} onChange={(roleId) => setMemberForm((prev) => ({ ...prev, roleId }))} />
        <FormField keyboardType="numeric" label={locale === "ar" ? "نسبة العمولة" : "Commission rate"} value={memberForm.commissionRate} onChangeText={(commissionRate) => setMemberForm((prev) => ({ ...prev, commissionRate }))} />
        <PrimaryButton disabled={saving} label={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ" : "Save")} onPress={saveMember} />
      </FormModal>
    </>
  );
}

