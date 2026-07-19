// VoiceFX — 雪莉的声音特效链(唯一实现)。
// pet.html 的正式播放和 config.html 的音色试听共用这一份,保证"试听听到的=她真实的声音"。
// 贾维斯链:带通 EQ(通信底色+金属脆感) → 并联[干声|太空舱混响|合唱失谐|金属梳状Flanger|环形调制]
// → 压缩 + tanh 软削波。全 WebAudio 实时合成,零素材。
(function () {
  function build(c) {
    const inHP = c.createBiquadFilter(); inHP.type = "highpass"; inHP.frequency.value = 110;
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 7200;
    const pres = c.createBiquadFilter(); pres.type = "peaking"; pres.frequency.value = 3000; pres.gain.value = 6; pres.Q.value = 1.2;
    inHP.connect(lp); lp.connect(pres);
    const sum = c.createGain();
    // 干声直达
    const dry = c.createGain(); dry.gain.value = 0.8; pres.connect(dry); dry.connect(sum);
    // 太空舱混响:合成脉冲响应,短尾巴不糊
    const conv = c.createConvolver();
    { const rate = c.sampleRate, len = Math.floor(rate * 0.5);
      const ir = c.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
      conv.buffer = ir; }
    const wet = c.createGain(); wet.gain.value = 0.5; pres.connect(conv); conv.connect(wet); wet.connect(sum);
    // 合唱/失谐
    const chDly = c.createDelay(0.1); chDly.delayTime.value = 0.022;
    const chLfo = c.createOscillator(); chLfo.frequency.value = 0.35;
    const chDepth = c.createGain(); chDepth.gain.value = 0.003;
    chLfo.connect(chDepth); chDepth.connect(chDly.delayTime); chLfo.start();
    const chG = c.createGain(); chG.gain.value = 0.5;
    pres.connect(chDly); chDly.connect(chG); chG.connect(sum);
    // 金属梳状/Flanger
    const mDly = c.createDelay(0.05); mDly.delayTime.value = 0.006;
    const mFb = c.createGain(); mFb.gain.value = 0.6;
    mDly.connect(mFb); mFb.connect(mDly);
    const flLfo = c.createOscillator(); flLfo.frequency.value = 0.2;
    const flDepth = c.createGain(); flDepth.gain.value = 0.0025;
    flLfo.connect(flDepth); flDepth.connect(mDly.delayTime); flLfo.start();
    const mG = c.createGain(); mG.gain.value = 0.45;
    pres.connect(mDly); mDly.connect(mG); mG.connect(sum);
    // 环形调制(机器人签名音)
    const ring = c.createGain(); ring.gain.value = 0;
    const ringOsc = c.createOscillator(); ringOsc.frequency.value = 150; ringOsc.connect(ring.gain); ringOsc.start();
    const ringG = c.createGain(); ringG.gain.value = 0.4;
    pres.connect(ring); ring.connect(ringG); ringG.connect(sum);
    // 总线:压缩 + tanh 软削波
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.25;
    const clip = c.createWaveShaper();
    { const n = 1024, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(1.5 * x); }
      clip.curve = curve; }
    const out = c.createGain(); out.gain.value = 0.85;
    sum.connect(comp); comp.connect(clip); clip.connect(out);
    return { input: inHP, output: out };
  }
  window.VoiceFX = { build };
})();
