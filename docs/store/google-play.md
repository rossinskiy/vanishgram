# Google Play listing: copy and answers

Package name: `win.karatel.vanishgram` (cannot be changed after the first upload).
Upload file: `Vanishgram-<version>.aab`, signed with the upload key (`node scripts/sign-android.mjs`).

## Store listing, English (en-US)

**App name** (30 max): Vanishgram

**Short description** (80 max):
Private messenger. Sign up with 12 words: no phone number, no email.

**Full description** (4000 max):
Vanishgram is a messenger that does not ask who you are.

There is no phone number and no email. You sign up by writing down 12 words. Those words are your account: with them you can sign in on another device, and without them nobody can, including us.

What it does
- Private chats, groups and channels, with voice messages and file sharing.
- End-to-end encryption on every message. One-to-one chats use the Signal protocol (the official libsignal library, with post-quantum key agreement). Groups use MLS, the IETF group encryption standard.
- Voice calls, encrypted between the two devices.
- Messages that disappear after a time you choose.
- Several devices on one account. You can move your chat history to a new device by approving it on the old one.
- Light and dark theme.

What the server sees
The server keeps encrypted messages only until they are delivered. It cannot read them, and it has no phone numbers or emails to give anyone.

Open source
The apps and the encryption code are published at https://github.com/rossinskiy/vanishgram so that anyone can check what runs on their phone.

Good to know
This is an early version. Notifications arrive only while the app is open; push notifications are not built yet.

**Privacy policy URL:** https://vanishgram.karatel.win/privacy
**Website:** https://vanishgram.karatel.win
**Contact email:** use the account's own address in the console (the console requires one; it is shown on the listing).

## Store listing, Russian (ru-RU)

**Название:** Vanishgram

**Краткое описание:**
Приватный мессенджер. Регистрация по 12 словам: без номера телефона и почты.

**Полное описание:**
Vanishgram не спрашивает, кто вы.

Нет номера телефона и нет почты. Вы регистрируетесь, записав 12 слов. Эти слова и есть ваш аккаунт: по ним вы войдёте на другом устройстве, а без них не войдёт никто, включая нас.

Что умеет
- Личные чаты, группы и каналы, голосовые сообщения и файлы.
- Сквозное шифрование всех сообщений. Личные чаты используют протокол Signal (официальная библиотека libsignal, с постквантовым обменом ключами). Группы используют MLS, стандарт IETF для групповых чатов.
- Голосовые звонки, зашифрованные между двумя устройствами.
- Сообщения, которые исчезают через выбранное вами время.
- Несколько устройств на одном аккаунте. Историю чатов можно перенести на новое устройство, подтвердив это на старом.
- Светлая и тёмная темы.

Что видит сервер
Сервер хранит зашифрованные сообщения только до доставки. Прочитать их он не может, а номеров телефонов и почт, которые можно кому-то выдать, у него нет.

Открытый код
Приложения и код шифрования опубликованы на https://github.com/rossinskiy/vanishgram, чтобы любой мог проверить, что работает на его телефоне.

Важно знать
Это ранняя версия. Уведомления приходят только при открытом приложении: push-уведомлений пока нет.

## Graphics

- App icon 512x512: `docs/store/icon-512.png`
- Feature graphic 1024x500: `docs/store/feature-graphic.png`
- Phone screenshots (at least 2, 16:9 to 9:16): take them in the app on a real phone or emulator. Not generated here because they must show the real interface.

## App content answers

- **App access:** all features are available after signing up inside the app. No account is needed from the reviewer: choose "Create account", write down the 12 words, continue. (If the console demands credentials, create an account and paste its 12 words in the instructions.)
- **Ads:** no.
- **Target audience:** 18 and over (an anonymous messenger with user-generated content; do not select children).
- **Content rating questionnaire:** category "Communication". The app lets users exchange messages and media with other users, so answer yes to "users can interact" and "shares user-generated content"; no violence, no sexual content, no gambling in the app itself.
- **News app, COVID, government app:** no.
- **Financial features, health features:** none.

## Data safety form

Collected and shared: nothing is sold or used for ads.
- **Personal info:** none collected (no name, email, phone number, address).
- **User IDs:** an account identifier is created at sign-up and stored on the server so messages can be delivered. Collected: yes. Shared: no. Optional: no. Purpose: app functionality, account management. Not used for tracking.
- **Messages:** collected: yes (end-to-end encrypted ciphertext, held only until delivered). Shared: no. Purpose: app functionality. Data is encrypted in transit and the content is unreadable by the developer.
- **Photos and videos, audio files, other files:** only when the user sends them; same handling as messages (encrypted, held only until delivered). Mark as collected for app functionality.
- **Audio (voice or sound recordings):** the microphone is used for voice messages and calls; recordings are sent end-to-end encrypted and are not kept by the developer.
- **Location, contacts, calendar, health, financial, web history, installed apps, device or other IDs, diagnostics:** not collected.
- **Security practices:** data is encrypted in transit: yes. Users can request data deletion: yes (account deletion in the app; wording to match the privacy policy).

## First release checklist for a new personal developer account

1. Pay the one-time registration fee and verify identity in the Play Console.
2. Create the app with the package name above, upload the `.aab` to a closed testing track.
3. New personal accounts must run a closed test with at least 12 testers for 14 days before production access. Add testers by email or a Google group.
4. Complete the listing, content rating, data safety and app access sections with the answers above.
5. Apply for production access, then promote the same release.
