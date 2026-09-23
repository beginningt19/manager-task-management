export type MicrophoneCheck =
  | { ok: true }
  | { ok: false; message: string }

export const checkMicrophoneForSpeech = async (): Promise<MicrophoneCheck> => {
  if (!window.isSecureContext) {
    return { ok: false, message: 'Гласовото въвеждане изисква защитена HTTPS връзка.' }
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, message: 'Този браузър не дава достъп до микрофона през сайта. Използвайте актуален Chrome или Edge.' }
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })

    const liveTrack = stream.getAudioTracks().find((track) => track.readyState === 'live' && track.enabled)
    stream.getTracks().forEach((track) => track.stop())

    if (!liveTrack) {
      return { ok: false, message: 'Микрофонът е разрешен, но браузърът не получава активен аудио вход.' }
    }

    return { ok: true }
  } catch (error) {
    const name = error instanceof DOMException ? error.name : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return {
        ok: false,
        message: 'Достъпът до микрофона е блокиран от браузъра или от системните настройки на устройството.',
      }
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return { ok: false, message: 'Не е открит работещ микрофон на това устройство.' }
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return {
        ok: false,
        message: 'Микрофонът е разрешен, но в момента не може да бъде използван. Проверете дали друго приложение не го е заело.',
      }
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return { ok: false, message: 'Избраният микрофон не може да бъде стартиран с текущите настройки.' }
    }
    return { ok: false, message: 'Микрофонът не можа да бъде стартиран от браузъра.' }
  }
}

export const speechRecognitionErrorMessage = (error: string) => {
  switch (error) {
    case 'not-allowed':
      return 'Браузърът отказа достъп до микрофона. Проверете разрешението за този сайт.'
    case 'service-not-allowed':
      return 'Микрофонът е разрешен, но услугата за разпознаване на реч е блокирана от браузъра или фирмена политика.'
    case 'audio-capture':
      return 'Разпознаването не получава звук от микрофона. Проверете избрания вход в Windows и браузъра.'
    case 'network':
      return 'Разпознаването на реч не можа да се свърже с услугата си. Проверете интернет връзката, VPN или защитната стена.'
    case 'language-not-supported':
      return 'Този браузър не поддържа разпознаване на български език.'
    case 'no-speech':
      return 'Не беше разпозната реч. Говорете след като микрофонът стане активен.'
    case 'aborted':
      return ''
    default:
      return `Гласовото въвеждане беше прекъснато (${error || 'неизвестна грешка'}).`
  }
}
