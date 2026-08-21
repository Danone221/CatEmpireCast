# Cat Empire — app Android

App-casca em **WebView** que carrega [`cat-empire.onrender.com`](https://cat-empire.onrender.com)
de tela cheia, como um navegador dedicado só pro site — igual o app do
Discord faz por baixo dos panos (o deles é mais elaborado, mas o princípio
de "web app com pontes nativas" é o mesmo).

## Por que WebView e não nativo puro

O site já tem tudo (canais de texto/voz, chat com imagem, WebRTC de
áudio/vídeo/tela via Socket.io). Reimplementar isso nativamente em Kotlin
seria recomeçar do zero um sistema que já funciona. O WebView reaproveita
100% do backend e da lógica existente — só precisa das pontes que um app
tem e um navegador solto não:

| Recurso da página | Ponte nativa que implementamos |
|---|---|
| `getUserMedia()` (mic/câmera) | `onPermissionRequest` pede a permissão Android real e libera pro WebView |
| `<input type="file">` (upload de imagem no chat) | `onShowFileChooser` abre galeria/câmera nativa |
| `getDisplayMedia()` (compartilhar tela) | Depende do WebView do aparelho — ver ressalva abaixo |
| Botão voltar do Android | Navega no histórico da própria WebView antes de fechar o app |
| Login com Discord | Segue normal dentro do WebView (é só uma navegação a mais) |

## ⚠️ Ressalva sobre compartilhar tela

`getDisplayMedia()` (botão 🖥️ do site, compartilhar tela pelo navegador)
dentro de um WebView embutido em app é inconsistente entre aparelhos/versões
de Android System WebView — em alguns funciona, em outros o próprio Chromium
recusa ou nunca abre o seletor, e não tem bandeira nenhuma que a gente possa
forçar do lado do app pra garantir que funcione. **Não conte com ele no
celular.** Por isso o site tem o botão **📱 Celular** dentro da chamada: ele
usa RTMP (via app tipo Larix Broadcaster) em vez de `getDisplayMedia()`, e
esse caminho funciona igual em qualquer Android ou iPhone, dentro ou fora
desse app — é o caminho recomendado pra transmitir tela pelo celular.

Chegamos a manter um `ScreenCaptureNotifier` (foreground service) rodando
preventivamente só pra satisfazer a exigência do Android 14+ de ter um
serviço tipo `mediaProjection` ativo durante captura de tela — só que isso
causava o app **fechar sozinho** ao entrar numa sala: no Android 14+, só dá
pra subir esse tipo de foreground service depois que o app já tem em mãos
um token de MediaProjection válido (resultado do diálogo de permissão), e
como quem trata `getDisplayMedia()` é o próprio Chromium (o app nunca vê
esse token), start*ar o serviço de forma "preventiva" sempre falhava com
`SecurityException`. Removido — mic, câmera, chat e canais continuam 100%
funcionais.

## Como gerar o APK

**Opção 1 — GitHub Actions (recomendado, não precisa Android Studio):**
Dá push nesse projeto pro GitHub → aba **Actions** → o workflow
`Build Cat Empire APK` roda sozinho → baixa o artefato `cat-empire-debug-apk`
gerado. Também dá pra disparar manualmente pelo botão "Run workflow".

**Opção 2 — Local, com Android Studio:**
Abre a pasta `CatEmpireCast/` no Android Studio → espera sincronizar o
Gradle → `Run`. Precisa de JDK 17 e o Android SDK (o Android Studio já
resolve isso sozinho).

## Trocar o domínio do site

Só um lugar: `app/src/main/res/values/strings.xml`, string `app_base_url`.

## Assinar pra distribuir (release, fora da Play Store)

O workflow atual gera **debug** (instalável direto, mas não otimizado pra
distribuição pública). Pra gerar um `.apk` de release assinado, seria
preciso configurar um keystore — não incluído aqui de propósito (chave de
assinatura é sensível). Se quiser isso, é um passo à parte.
