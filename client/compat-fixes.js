/*
 * CAT EMPIRE — compatibilidade mobile / WebView
 *
 * Correções isoladas para não alterar a lógica principal de room.js:
 * 1) libera a câmera atual antes de trocar de câmera em celulares;
 * 2) usa deviceId como fallback quando facingMode falhar;
 * 3) cria o modal de convite ANTES de room.js registrar os eventos;
 * 4) carrega os aprimoramentos Discord-like depois que room.js termina.
 */
(function () {
  'use strict';

  // ================================================================
  // CÂMERA MOBILE — fallback robusto para troca frontal/traseira
  // ================================================================
  const mediaDevices = navigator.mediaDevices;
  if (mediaDevices && typeof mediaDevices.getUserMedia === 'function') {
    const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    let activeCameraStream = null;
    let activeCameraDeviceId = null;

    function hasVideoRequest(constraints) {
      return !!constraints && !!constraints.video && typeof constraints.video === 'object';
    }

    function copyVideoConstraints(video) {
      if (!video || typeof video !== 'object') return {};
      return { ...video };
    }

    function rememberCameraStream(stream) {
      const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
      if (!track) return stream;
      activeCameraStream = stream;
      try {
        activeCameraDeviceId = track.getSettings().deviceId || null;
      } catch (_) {
        activeCameraDeviceId = null;
      }
      track.addEventListener('ended', () => {
        if (activeCameraStream === stream) activeCameraStream = null;
      }, { once: true });
      return stream;
    }

    async function requestSpecificCamera(constraints, deviceId) {
      const video = copyVideoConstraints(constraints.video);
      delete video.facingMode;
      video.deviceId = { exact: deviceId };
      return originalGetUserMedia({ ...constraints, video });
    }

    mediaDevices.getUserMedia = async function (constraints) {
      if (!hasVideoRequest(constraints)) {
        return originalGetUserMedia(constraints);
      }

      const previousStream = activeCameraStream;
      const previousDeviceId = activeCameraDeviceId;

      if (previousStream) {
        previousStream.getVideoTracks().forEach(track => {
          try { track.stop(); } catch (_) {}
        });
        activeCameraStream = null;
      }

      try {
        return rememberCameraStream(await originalGetUserMedia(constraints));
      } catch (firstError) {
        const facing = constraints.video.facingMode;
        const desiredFacing = typeof facing === 'string'
          ? facing
          : (facing && (facing.exact || facing.ideal));

        try {
          const devices = await mediaDevices.enumerateDevices();
          const cameras = devices.filter(d => d.kind === 'videoinput');
          const candidates = cameras.filter(d => !previousDeviceId || d.deviceId !== previousDeviceId);
          const normalizedLabels = candidates.map(d => ({ device: d, label: (d.label || '').toLowerCase() }));
          const preferred = desiredFacing === 'environment'
            ? normalizedLabels.find(x => /back|rear|traseira|environment|c[aâ]mera\s*2/.test(x.label))
            : normalizedLabels.find(x => /front|user|frontal|selfie|c[aâ]mera\s*1/.test(x.label));
          const target = (preferred && preferred.device) || candidates[0];
          if (target) {
            try {
              return rememberCameraStream(await requestSpecificCamera(constraints, target.deviceId));
            } catch (_) {}
          }
        } catch (_) {}

        if (desiredFacing === 'user' || desiredFacing === 'environment') {
          try {
            const video = copyVideoConstraints(constraints.video);
            video.facingMode = { exact: desiredFacing };
            return rememberCameraStream(await originalGetUserMedia({ ...constraints, video }));
          } catch (_) {}
        }

        if (previousDeviceId) {
          try {
            return rememberCameraStream(await requestSpecificCamera(constraints, previousDeviceId));
          } catch (_) {}
        }

        throw firstError;
      }
    };
  }

  // ================================================================
  // CONVITES — o modal precisa existir ANTES de room.js registrar eventos
  // ================================================================
  function ensureInviteModal() {
    if (document.getElementById('inviteModal')) return;

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'inviteModal';
    modal.innerHTML = `
      <div class="modal-box invite-modal-box" style="width:min(620px,94vw)">
        <h2>🔗 Convidar para o servidor</h2>
        <p class="modal-hint">Compartilhe este link para outras pessoas entrarem neste servidor.</p>
        <div class="kv-row" style="align-items:center;gap:8px">
          <span class="kv-value" id="inviteLinkText" style="flex:1;word-break:break-all">Gerando link de convite…</span>
          <button type="button" class="btn kv-copy" id="copyInviteBtn">Copiar</button>
        </div>
        <div class="invite-generation-box" style="margin-top:14px;padding:12px;border:1px solid #3b1b68;background:#0d0618">
          <div class="kv-row" style="margin-bottom:10px">
            <span class="kv-label">EXPIRAÇÃO</span>
            <select id="inviteExpireSelect">
              <option value="1">1 hora</option>
              <option value="24" selected>24 horas</option>
              <option value="72">3 dias</option>
              <option value="168">7 dias</option>
              <option value="0">Nunca</option>
            </select>
          </div>
          <div class="kv-row">
            <span class="kv-label">LIMITE DE USOS</span>
            <select id="inviteMaxUsesSelect">
              <option value="0" selected>Ilimitado</option>
              <option value="1">1 uso</option>
              <option value="5">5 usos</option>
              <option value="10">10 usos</option>
              <option value="50">50 usos</option>
            </select>
          </div>
          <div class="modal-actions" style="margin-top:12px">
            <button type="button" class="btn btn-primary" id="generateInviteBtn">Gerar novo convite</button>
          </div>
        </div>
        <div id="adminInvitesListWrap" hidden style="margin-top:16px">
          <h3 style="font-size:10px;margin:0 0 8px">CONVITES ATIVOS</h3>
          <div id="adminInvitesList"></div>
        </div>
        <div class="modal-actions" style="margin-top:16px">
          <button type="button" class="btn btn-primary" id="closeInviteModalBtn">Fechar</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }

  // server.html já chegou ao fim antes deste script, então o modal pode ser
  // criado imediatamente. Isso garante que room.js encontre todos os IDs.
  ensureInviteModal();

  // ================================================================
  // APRIMORAMENTOS — carregar somente depois de room.js
  // ================================================================
  function loadEnhancements() {
    if (document.getElementById('catEmpireEnhancementsScript')) return;
    const script = document.createElement('script');
    script.id = 'catEmpireEnhancementsScript';
    script.src = '/enhancements.js?v=20260821';
    script.async = false;
    document.body.appendChild(script);
  }

  if (document.readyState === 'complete') {
    loadEnhancements();
  } else {
    window.addEventListener('load', loadEnhancements, { once: true });
  }
})();
