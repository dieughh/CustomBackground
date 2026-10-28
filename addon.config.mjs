/** @type {import('./addon.config.d.mts').AddonConfig} */
const addonConfig = {
    id: '09ad7be0-ca29-48a4-b0a3-14e7990d05c9',
    directoryName: 'custom-background',
    name: 'Custom Background',
    description: 'Скрипт, который позволяет менять глобальный фон приложения и фон блока «Моя волна» на любое изображение или видео.',
    version: '2.0.0',
    author: 'dieugh',
    image: 'Assets/logo.png',
    banner: 'Assets/banner.png',
    libraryLogo: 'Assets/logo.png',
    tags: ['background', 'custom', 'media'],
    dependencies: [],
    allowedUrls: [
        'https://*.yandex.net/*',
        'https://avatars.yandex.net/*'
    ],
    supportedVersions: [],
    cssScope: 'global',
    requirements: {
        minHostApi: 1,
        capabilities: ['lifecycle-v1', 'async-start-v1', 'net-per-addon-v1'],
    },
}

export default addonConfig