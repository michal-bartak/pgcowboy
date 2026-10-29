---
title: Renaming a role
description: Change a role's name on every cluster it was loaded from
---

Once a role is loaded, its **Login name** is editable. Type a new name and the rename is staged like any other edit. The ↺ button beside the field, greyed out until you change the name, then puts the old name back — hover it to see *Renamed from: …*. Clearing the field stages nothing.

The rename is published with everything else on **Save changes**. On each cluster where the role exists, `ALTER ROLE … RENAME TO …` runs **first** in that cluster's transaction, so the other changes you staged (parents, attributes, settings, password, comment) apply to the renamed role. Memberships, attributes, settings, the comment and owned objects all stay with the role — PostgreSQL renames it in place.

- A cluster you [add the role to](/pgcowboy/usage/presence/) gets it **created under the new name**.
- A cluster you drop it from has the **old name** dropped; it is not renamed first.
- Only the clusters the role was loaded from are renamed — the same [scope](/pgcowboy/usage/) as every other edit.

## Confirmation

Before anything is sent, the app looks the new name up on the same clusters.

If the new name is **already taken** on any of them, the save stops there: a popup names those clusters, and the only way out is **Close**. Renaming on the other clusters only would leave the role named differently across clusters, so nothing is saved — pick another name, or deal with the existing role first.

Otherwise the only thing left to say is the MD5 note below. When it applies, a popup lists the clusters that will be renamed and asks you to continue; when it doesn't — **Set password** is ticked, or the warning is suppressed — the save goes straight through with no popup.

:::caution
A password stored as an **MD5** hash is cleared by a rename, because the hash includes the role name. SCRAM passwords are kept. If your clusters still use MD5, tick **Set password** in the same save — the password is applied after the rename, so it is hashed under the new name.
:::

If your clusters don't use MD5 (SCRAM, LDAP and so on), tick **Suppress this warning** under the note and it won't be shown again. The same option is in [Settings → General](/pgcowboy/configuration/general/#suppress-the-md5-password-warning-on-rename), where you can turn the warning back on.

The SQL that runs is the configurable `Rename role` [template](/pgcowboy/configuration/call-templates/).
