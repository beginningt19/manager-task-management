export type BulgarianVoiceCommandReference = {
  spoken: string[]
  output: string
  description: string
}

type VoiceCommand = {
  phrases: string[]
  replacement: string
  description: string
}

const voiceCommands: VoiceCommand[] = [
  { phrases: ['точка и запетая'], replacement: ';', description: 'Точка и запетая' },
  { phrases: ['въпросителен знак', 'въпросителна'], replacement: '?', description: 'Въпросителен знак' },
  { phrases: ['удивителен знак', 'удивителна'], replacement: '!', description: 'Удивителен знак' },
  { phrases: ['двоеточие'], replacement: ':', description: 'Двоеточие' },
  { phrases: ['многоточие'], replacement: '…', description: 'Многоточие' },
  { phrases: ['запетая'], replacement: ',', description: 'Запетая' },
  { phrases: ['точка'], replacement: '.', description: 'Точка' },

  { phrases: ['обратна наклонена черта', 'обратен слеш', 'бекслеш'], replacement: '\\', description: 'Обратна наклонена черта' },
  { phrases: ['наклонена черта', 'слеш'], replacement: '/', description: 'Наклонена черта' },

  { phrases: ['отваряме скоба', 'отваряща скоба', 'лява скоба'], replacement: '(', description: 'Отваряща кръгла скоба' },
  { phrases: ['затваряме скоба', 'затваряща скоба', 'дясна скоба'], replacement: ')', description: 'Затваряща кръгла скоба' },
  { phrases: ['отваряме квадратна скоба', 'отваряща квадратна скоба'], replacement: '[', description: 'Отваряща квадратна скоба' },
  { phrases: ['затваряме квадратна скоба', 'затваряща квадратна скоба'], replacement: ']', description: 'Затваряща квадратна скоба' },
  { phrases: ['отваряме фигурна скоба', 'отваряща фигурна скоба'], replacement: '{', description: 'Отваряща фигурна скоба' },
  { phrases: ['затваряме фигурна скоба', 'затваряща фигурна скоба'], replacement: '}', description: 'Затваряща фигурна скоба' },

  { phrases: ['отваряме кавички', 'отварящи кавички', 'отворени кавички'], replacement: '„', description: 'Отварящи български кавички' },
  { phrases: ['затваряме кавички', 'затварящи кавички', 'затворени кавички'], replacement: '“', description: 'Затварящи български кавички' },
  { phrases: ['апостроф', 'единична кавичка'], replacement: "'", description: 'Апостроф / единична кавичка' },

  { phrases: ['хаштаг', 'хештаг', 'решетка'], replacement: '#', description: 'Хаштаг / решетка' },
  { phrases: ['знак равно', 'равно'], replacement: '=', description: 'Знак равно' },
  { phrases: ['знак плюс', 'плюс'], replacement: '+', description: 'Знак плюс' },
  { phrases: ['знак минус', 'минус'], replacement: '−', description: 'Знак минус' },
  { phrases: ['звездичка', 'астериск'], replacement: '*', description: 'Звездичка' },
  { phrases: ['процент', 'процента', 'знак процент'], replacement: '%', description: 'Процент' },
  { phrases: ['амперсанд', 'и знак'], replacement: '&', description: 'Амперсанд' },
  { phrases: ['маймунско а', 'кльомба', 'ет знак'], replacement: '@', description: 'Знак @' },
  { phrases: ['долна черта', 'долно тире'], replacement: '_', description: 'Долна черта' },

  { phrases: ['тире'], replacement: ' - ', description: 'Тире' },
  { phrases: ['нов абзац'], replacement: '\n\n', description: 'Нов абзац' },
  { phrases: ['нов ред'], replacement: '\n', description: 'Нов ред' },
]

export const bulgarianVoiceCommandReference: BulgarianVoiceCommandReference[] = voiceCommands.map((command) => ({
  spoken: command.phrases,
  output: command.replacement,
  description: command.description,
}))

const escapeRegExp = (value: string) => value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')

const replaceVoiceCommands = (value: string) => {
  let next = ' ' + value + ' '
  const phrases = voiceCommands
    .flatMap((command) => command.phrases.map((phrase) => ({ phrase, replacement: command.replacement })))
    .sort((a, b) => b.phrase.length - a.phrase.length)

  for (const { phrase, replacement } of phrases) {
    const pattern = new RegExp('(^|\\s)' + escapeRegExp(phrase) + '(?=\\s|$|[,.!?;:])', 'giu')
    next = next.replace(pattern, (_match, prefix: string) => prefix + replacement)
  }

  return next
}

const bulgarianCardinalNumbers: Record<string, number> = {
  'нула': 0, 'един': 1, 'една': 1, 'едно': 1, 'два': 2, 'две': 2, 'три': 3, 'четири': 4, 'пет': 5,
  'шест': 6, 'седем': 7, 'осем': 8, 'девет': 9, 'десет': 10,
  'единадесет': 11, 'единайсет': 11, 'дванадесет': 12, 'дванайсет': 12,
  'тринадесет': 13, 'тринайсет': 13, 'четиринадесет': 14, 'четиринайсет': 14,
  'петнадесет': 15, 'петнайсет': 15, 'шестнадесет': 16, 'шестнайсет': 16,
  'седемнадесет': 17, 'седемнайсет': 17, 'осемнадесет': 18, 'осемнайсет': 18,
  'деветнадесет': 19, 'деветнайсет': 19, 'двадесет': 20, 'двайсет': 20,
  'тридесет': 30, 'трийсет': 30, 'четиридесет': 40, 'четирсет': 40, 'четирсе': 40,
  'петдесет': 50, 'пейсе': 50, 'шестдесет': 60, 'шейсет': 60,
  'седемдесет': 70, 'седемсе': 70, 'осемдесет': 80, 'осемсе': 80,
  'деветдесет': 90, 'деветсе': 90,
  'сто': 100, 'двеста': 200, 'триста': 300, 'четиристотин': 400, 'четристотин': 400, 'петстотин': 500,
  'шестстотин': 600, 'седемстотин': 700, 'осемстотин': 800, 'деветстотин': 900,
}

const bulgarianOrdinalNumbers: Record<string, number> = {
  'първи': 1, 'първа': 1, 'първо': 1, 'втори': 2, 'втора': 2, 'второ': 2,
  'трети': 3, 'трета': 3, 'трето': 3, 'четвърти': 4, 'четвърта': 4, 'четвърто': 4,
  'пети': 5, 'пета': 5, 'пето': 5, 'шести': 6, 'шеста': 6, 'шесто': 6,
  'седми': 7, 'седма': 7, 'седмо': 7, 'осми': 8, 'осма': 8, 'осмо': 8,
  'девети': 9, 'девета': 9, 'девето': 9, 'десети': 10, 'десета': 10, 'десето': 10,
  'единадесети': 11, 'единадесета': 11, 'единайсети': 11, 'единайсета': 11,
  'дванадесети': 12, 'дванадесета': 12, 'дванайсети': 12, 'дванайсета': 12,
  'тринадесети': 13, 'тринадесета': 13, 'тринайсети': 13, 'тринайсета': 13,
  'четиринадесети': 14, 'четиринадесета': 14, 'четиринайсети': 14, 'четиринайсета': 14,
  'петнадесети': 15, 'петнадесета': 15, 'петнайсети': 15, 'петнайсета': 15,
  'шестнадесети': 16, 'шестнадесета': 16, 'шестнайсети': 16, 'шестнайсета': 16,
  'седемнадесети': 17, 'седемнадесета': 17, 'седемнайсети': 17, 'седемнайсета': 17,
  'осемнадесети': 18, 'осемнадесета': 18, 'осемнайсети': 18, 'осемнайсета': 18,
  'деветнадесети': 19, 'деветнадесета': 19, 'деветнайсети': 19, 'деветнайсета': 19,
  'двадесети': 20, 'двадесета': 20, 'двайсети': 20, 'двайсета': 20,
  'тридесети': 30, 'тридесета': 30, 'трийсети': 30, 'трийсета': 30,
  'четиридесети': 40, 'четиридесета': 40, 'петдесети': 50, 'петдесета': 50,
  'шестдесети': 60, 'шестдесета': 60, 'шейсети': 60, 'шейсета': 60,
  'седемдесети': 70, 'седемдесета': 70, 'осемдесети': 80, 'осемдесета': 80,
  'деветдесети': 90, 'деветдесета': 90,
}

const bulgarianNumberScales: Record<string, number> = {
  'хиляда': 1000, 'хиляди': 1000,
  'милион': 1000000, 'милиона': 1000000, 'милиони': 1000000,
  'милиард': 1000000000, 'милиарда': 1000000000, 'милиарди': 1000000000,
}

const bulgarianDecimalMarkers = new Set(['цяло', 'цяла', 'цели'])

const isBulgarianNumberLexeme = (word: string) =>
  Object.prototype.hasOwnProperty.call(bulgarianCardinalNumbers, word)
  || Object.prototype.hasOwnProperty.call(bulgarianOrdinalNumbers, word)
  || Object.prototype.hasOwnProperty.call(bulgarianNumberScales, word)
  || word === 'стотин'
  || bulgarianDecimalMarkers.has(word)

const parseBulgarianIntegerWords = (words: string[]): string | null => {
  const meaningful = words.filter((word) => word !== 'и')
  if (!meaningful.length) return null

  if (!words.includes('и') && meaningful.length > 1 && meaningful.every((word) => {
    const number = bulgarianCardinalNumbers[word]
    return number !== undefined && number >= 0 && number <= 9
  })) {
    return meaningful.map((word) => String(bulgarianCardinalNumbers[word])).join('')
  }

  let total = 0
  let current = 0
  let sawNumber = false

  for (const word of meaningful) {
    const direct = bulgarianCardinalNumbers[word] ?? bulgarianOrdinalNumbers[word]
    if (direct !== undefined) {
      current += direct
      sawNumber = true
      continue
    }

    if (word === 'стотин') {
      current = (current || 1) * 100
      sawNumber = true
      continue
    }

    const scale = bulgarianNumberScales[word]
    if (scale !== undefined) {
      total += (current || 1) * scale
      current = 0
      sawNumber = true
      continue
    }

    return null
  }

  return sawNumber ? String(total + current) : null
}

const parseBulgarianNumberWords = (words: string[]): string | null => {
  const decimalIndex = words.findIndex((word) => bulgarianDecimalMarkers.has(word))
  if (decimalIndex === -1) return parseBulgarianIntegerWords(words)

  const integerWords = words.slice(0, decimalIndex).filter((word) => word !== 'и')
  const decimalWords = words.slice(decimalIndex + 1).filter((word) => word !== 'и')
  const integerPart = parseBulgarianIntegerWords(integerWords)
  const decimalPart = parseBulgarianIntegerWords(decimalWords)
  if (integerPart === null || decimalPart === null) return null
  return integerPart + ',' + decimalPart
}

const applyBulgarianNumberWords = (value: string) => {
  const parts = value.match(/[А-Яа-я]+|\d+(?:[.,]\d+)?|\s+|[^А-Яа-я\d\s]+/g) || [value]
  let result = ''
  let index = 0

  const nextNonSpace = (from: number) => {
    let cursor = from
    while (cursor < parts.length && /^\s+$/.test(parts[cursor])) cursor += 1
    return cursor
  }

  while (index < parts.length) {
    const token = parts[index]
    const normalized = token.toLocaleLowerCase('bg-BG')
    if (!/^[А-Яа-я]+$/.test(token) || !isBulgarianNumberLexeme(normalized)) {
      result += token
      index += 1
      continue
    }

    const words: string[] = []
    let cursor = index
    let lastAcceptedEnd = index
    let hasOrdinal = false

    while (cursor < parts.length) {
      const candidate = parts[cursor]
      if (/^\s+$/.test(candidate)) {
        cursor += 1
        continue
      }

      if (!/^[А-Яа-я]+$/.test(candidate)) break
      const word = candidate.toLocaleLowerCase('bg-BG')

      if (isBulgarianNumberLexeme(word)) {
        words.push(word)
        if (Object.prototype.hasOwnProperty.call(bulgarianOrdinalNumbers, word)) hasOrdinal = true
        lastAcceptedEnd = cursor + 1
        cursor += 1
        continue
      }

      if (word === 'и' && words.length) {
        const followingIndex = nextNonSpace(cursor + 1)
        const following = parts[followingIndex]?.toLocaleLowerCase('bg-BG') || ''
        if (followingIndex < parts.length && /^[А-Яа-я]+$/.test(parts[followingIndex]) && isBulgarianNumberLexeme(following)) {
          words.push('и')
          lastAcceptedEnd = cursor + 1
          cursor += 1
          continue
        }
      }

      break
    }

    const parsed = parseBulgarianNumberWords(words)
    const numericWordCount = words.filter((word) => word !== 'и' && !bulgarianDecimalMarkers.has(word)).length
    if (parsed !== null && (!hasOrdinal || numericWordCount > 1)) {
      result += parsed
      index = lastAcceptedEnd
      continue
    }

    result += token
    index += 1
  }

  return result
}

const normalizePunctuationSpacing = (value: string) =>
  value
    .replace(/[ \t]+([,.;:?!…%\)\]\}“])/g, '$1')
    .replace(/([\(\[\{„#@])\s+/g, '$1')
    .replace(/\s*([/\\])\s*/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const capitalizeSentenceStarts = (value: string) => {
  const chars = Array.from(value)
  let capitalizeNext = true

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]

    if (/[А-Яа-яA-Za-z]/u.test(char)) {
      if (capitalizeNext) chars[index] = char.toLocaleUpperCase('bg-BG')
      capitalizeNext = false
      continue
    }

    if (char === '.' || char === '!' || char === '?' || char === '…' || char === '\n') {
      capitalizeNext = true
    }
  }

  return chars.join('')
}

export const applyBulgarianVoiceFormatting = (value: string) => {
  const commandsApplied = replaceVoiceCommands(value)
  const numbersApplied = applyBulgarianNumberWords(commandsApplied)
  return capitalizeSentenceStarts(normalizePunctuationSpacing(numbersApplied))
}

export const bulgarianVoiceNumberReference = {
  cardinals: bulgarianCardinalNumbers,
  ordinals: bulgarianOrdinalNumbers,
  scales: bulgarianNumberScales,
  decimalMarkers: [...bulgarianDecimalMarkers],
}
