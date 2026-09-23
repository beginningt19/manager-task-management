import part1 from './assets/office-intro/part1.txt?raw'
import part2 from './assets/office-intro/part2.txt?raw'
import part3 from './assets/office-intro/part3.txt?raw'
import part4 from './assets/office-intro/part4.txt?raw'
import part5 from './assets/office-intro/part5.txt?raw'
import part6 from './assets/office-intro/part6.txt?raw'
import part7 from './assets/office-intro/part7.txt?raw'

const officeIntroBase64 = [
  part1,
  part2,
  part3,
  part4,
  part5,
  part6,
  part7,
].map((part) => part.trim()).join('')

export const officeIntroImage = `data:image/webp;base64,${officeIntroBase64}`
