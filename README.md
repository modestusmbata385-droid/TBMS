# TBMS - Toangoma Boda Management System (Awamu ya 1)

## Kilichomo kwenye Awamu hii
- Usajili wa Driver (jina, simu, National ID, Leseni, namba ya pikipiki, emergency contact)
- Login (kwa namba ya simu)
- **Foleni ya FIFO** ya kweli - hakuna udanganyifu wa nafasi
- **Trip flow kamili**: Leader anaanzisha trip kwa driver wa #1 → Driver "NIMEFIKA" → Leader "Thibitisha Kuwasili" → Driver anarudi mwishoni mwa foleni kiotomatiki
- **Violations na Suspension/Ban**
- **Leader Dashboard**: stats, foleni ya live, kuthibitisha madereva wapya, kuthibitisha kuwasili
- **Super Admin Dashboard**: stats za jumla, orodha ya madereva wote
- **Real-time kwa WebSockets (Socket.IO)** - foleni inasasika yenyewe bila kureload

## Jinsi ya Kuwa Super Admin wa Kwanza
1. Kwenye Render, weka environment variable `SUPERADMIN_PHONE` = namba yako ya simu (mfano `0712345678`)
2. Jisajili kwenye app ukitumia namba hiyo hiyo ya simu
3. Utakuwa Super Admin moja kwa moja

## Jinsi ya Kufanya Mtu kuwa Leader
Baada ya kuwa Super Admin, tumia hii endpoint (kwa sasa kwa mkono, UI itaongezwa Awamu ya 2):
`POST /api/admin/make-leader/:userId`

## Amewekwa (Deferred) kwa Awamu ya 2
- Malipo ya TSh 500 kwa siku (M-Pesa/Tigo Pesa - inahitaji akaunti ya payment gateway)
- Contributions/Campaigns
- Community platform (posts/comments)
- Voice reporting
- Announcements
- Notifications za ndani ya app
- AI Driver Assistant (inahitaji akaunti ya AI API)
- QR Driver Identification
- Automatic working hours / auto open-close
- Emergency reporting
- Multi-station switching UI
- Audit logs UI (data inahifadhiwa tayari kwenye database)

## Deploy kwenye Render
Sawa na Mbata Agent: pakia GitHub → Render Blueprint → itaunda Web Service + Postgres kiotomatiki.
