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
| `getDisplayMedia()` (compartilhar tela) | O próprio WebView/Chromium mostra o seletor nativo — ver ressalva abaixo |
| Botão voltar do Android | Navega no histórico da própria WebView antes de fechar o app |
| Login com Discord | Segue normal dentro do WebView (é só uma navegação a mais) |

## ⚠️ Ressalva sobre compartilhar tela

`getDisplayMedia()` funcionando de dentro de um WebView embutido em app
(diferente do Chrome solto) depende da versão do **Android System WebView**
instalada no aparelho — em celulares atualizados (WebView de 2022+) costuma
funcionar sozinho, sem código nenhum da nossa parte. Mantemos o
`ScreenCaptureNotifier` rodando como rede de segurança pro requisito do
Android 14+ de ter um foreground service tipo `mediaProjection` ativo
durante a captura, mas **isso não foi testado em aparelho físico** — se não
funcionar de primeira num certo device, o resto do app (chat, canais, mic,
câmera) continua 100% funcional, e a gente ajusta a parte de tela depois.

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
