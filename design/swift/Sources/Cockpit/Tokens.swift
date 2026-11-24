import SwiftUI

public extension Cockpit {
  enum Color {
    public static let canvas = Cockpit.dynamic(dark: RGBA(0.0706, 0.0706, 0.0706, 1), light: RGBA(0.9804, 0.9804, 0.9804, 1), darkHC: RGBA(0.0706, 0.0706, 0.0706, 1), lightHC: RGBA(0.9804, 0.9804, 0.9804, 1))
    public static let sidebar = Cockpit.dynamic(dark: RGBA(0, 0, 0, 1), light: RGBA(0.9412, 0.9412, 0.9412, 1), darkHC: RGBA(0, 0, 0, 1), lightHC: RGBA(0.9412, 0.9412, 0.9412, 1))
    public static let surface = Cockpit.dynamic(dark: RGBA(0.0706, 0.0706, 0.0706, 1), light: RGBA(0.9804, 0.9804, 0.9804, 1), darkHC: RGBA(0.0706, 0.0706, 0.0706, 1), lightHC: RGBA(0.9804, 0.9804, 0.9804, 1))
    public static let raised = Cockpit.dynamic(dark: RGBA(0.1294, 0.1294, 0.1294, 1), light: RGBA(0.9137, 0.9137, 0.9137, 1), darkHC: RGBA(0.1294, 0.1294, 0.1294, 1), lightHC: RGBA(0.9137, 0.9137, 0.9137, 1))
    public static let alertGround = Cockpit.dynamic(dark: RGBA(0.102, 0.102, 0.102, 1), light: RGBA(1, 1, 1, 1), darkHC: RGBA(0.102, 0.102, 0.102, 1), lightHC: RGBA(1, 1, 1, 1))
    public static let actionDone = Cockpit.dynamic(dark: RGBA(1, 1, 1, 0.03), light: RGBA(0.1176, 0.1176, 0.1176, 0.03), darkHC: RGBA(1, 1, 1, 0.03), lightHC: RGBA(0, 0, 0, 0.03))
    public static let bubbleOwn = Cockpit.dynamic(dark: RGBA(0.1843, 0.1843, 0.1843, 1), light: RGBA(0.8745, 0.8745, 0.8745, 1), darkHC: RGBA(0.2275, 0.2275, 0.2275, 1), lightHC: RGBA(0.8235, 0.8235, 0.8235, 1))
    public static let well = Cockpit.dynamic(dark: RGBA(0.051, 0.051, 0.051, 1), light: RGBA(0.9569, 0.9569, 0.9569, 1), darkHC: RGBA(0.051, 0.051, 0.051, 1), lightHC: RGBA(0.9569, 0.9569, 0.9569, 1))
    public static let overlay = Cockpit.dynamic(dark: RGBA(0.1412, 0.1412, 0.1412, 1), light: RGBA(1, 1, 1, 1), darkHC: RGBA(0.1412, 0.1412, 0.1412, 1), lightHC: RGBA(1, 1, 1, 1))
    public static let scrim = Cockpit.dynamic(dark: RGBA(0, 0, 0, 0.5), light: RGBA(0.0941, 0.0941, 0.0941, 0.24), darkHC: RGBA(0, 0, 0, 0.7), lightHC: RGBA(0, 0, 0, 0.4))
    public static let glass = Cockpit.dynamic(dark: RGBA(0.1216, 0.1216, 0.1216, 0.64), light: RGBA(0.9804, 0.9804, 0.9804, 0.68), darkHC: RGBA(0.1059, 0.1059, 0.1059, 0.88), lightHC: RGBA(0.9804, 0.9804, 0.9804, 0.92))
    public static let hairline = Cockpit.dynamic(dark: RGBA(1, 1, 1, 0.07), light: RGBA(0.1176, 0.1176, 0.1176, 0.1), darkHC: RGBA(0.2392, 0.2392, 0.2392, 1), lightHC: RGBA(0.6431, 0.6431, 0.6431, 1))
    public static let phoneRule = Cockpit.dynamic(dark: RGBA(1, 1, 1, 0.1), light: RGBA(0.1176, 0.1176, 0.1176, 0.12), darkHC: RGBA(1, 1, 1, 0.1), lightHC: RGBA(0, 0, 0, 0.12))
    public static let border = Cockpit.dynamic(dark: RGBA(0.2314, 0.2314, 0.2314, 1), light: RGBA(0.7529, 0.7529, 0.7529, 1), darkHC: RGBA(0.3451, 0.3451, 0.3451, 1), lightHC: RGBA(0.502, 0.502, 0.502, 1))
    public static let strokeControl = Cockpit.dynamic(dark: RGBA(0.3804, 0.3804, 0.3804, 1), light: RGBA(0.5098, 0.5098, 0.5098, 1), darkHC: RGBA(0.5059, 0.5059, 0.5059, 1), lightHC: RGBA(0.451, 0.451, 0.451, 1))
    public static let text = Cockpit.dynamic(dark: RGBA(1, 1, 1, 1), light: RGBA(0.1176, 0.1176, 0.1176, 1), darkHC: RGBA(1, 1, 1, 1), lightHC: RGBA(0, 0, 0, 1))
    public static let textSecondary = Cockpit.dynamic(dark: RGBA(0.7333, 0.7333, 0.7333, 1), light: RGBA(0.2745, 0.2745, 0.2745, 1), darkHC: RGBA(0.8196, 0.8196, 0.8196, 1), lightHC: RGBA(0.2, 0.2, 0.2, 1))
    public static let textTertiary = Cockpit.dynamic(dark: RGBA(0.5529, 0.5529, 0.5529, 1), light: RGBA(0.3961, 0.3961, 0.3961, 1), darkHC: RGBA(0.6863, 0.6863, 0.6863, 1), lightHC: RGBA(0.298, 0.298, 0.298, 1))
    public static let textDisabled = Cockpit.dynamic(dark: RGBA(0.2235, 0.2235, 0.2235, 1), light: RGBA(0.6392, 0.6392, 0.6392, 1), darkHC: RGBA(0.4118, 0.4118, 0.4118, 1), lightHC: RGBA(0.5255, 0.5255, 0.5255, 1))
    public static let textInverse = Cockpit.dynamic(dark: RGBA(0.0588, 0.0588, 0.0588, 1), light: RGBA(1, 1, 1, 1), darkHC: RGBA(0.0588, 0.0588, 0.0588, 1), lightHC: RGBA(1, 1, 1, 1))
    public static let life = Cockpit.dynamic(dark: RGBA(0.8706, 0.8706, 0.8706, 1), light: RGBA(0.149, 0.149, 0.149, 1), darkHC: RGBA(0.9608, 0.9608, 0.9608, 1), lightHC: RGBA(0.051, 0.051, 0.051, 1))
    public static let lifeGlyph = Cockpit.dynamic(dark: RGBA(0.0588, 0.0588, 0.0588, 1), light: RGBA(1, 1, 1, 1), darkHC: RGBA(0.0588, 0.0588, 0.0588, 1), lightHC: RGBA(1, 1, 1, 1))
    public static let data2 = Cockpit.dynamic(dark: RGBA(0.7333, 0.7333, 0.7333, 1), light: RGBA(0.2824, 0.2824, 0.2824, 1), darkHC: RGBA(0.7922, 0.7922, 0.7922, 1), lightHC: RGBA(0.2196, 0.2196, 0.2196, 1))
    public static let data3 = Cockpit.dynamic(dark: RGBA(0.3804, 0.3804, 0.3804, 1), light: RGBA(0.5412, 0.5412, 0.5412, 1), darkHC: RGBA(0.5059, 0.5059, 0.5059, 1), lightHC: RGBA(0.451, 0.451, 0.451, 1))
    public static let data4 = Cockpit.dynamic(dark: RGBA(0.1922, 0.1922, 0.1922, 1), light: RGBA(0.8196, 0.8196, 0.8196, 1), darkHC: RGBA(0.3451, 0.3451, 0.3451, 1), lightHC: RGBA(0.6431, 0.6431, 0.6431, 1))
    public static let track = Cockpit.dynamic(dark: RGBA(0.0941, 0.0941, 0.0941, 1), light: RGBA(0.9294, 0.9294, 0.9294, 1), darkHC: RGBA(0.0941, 0.0941, 0.0941, 1), lightHC: RGBA(0.9294, 0.9294, 0.9294, 1))
    public static let storage1 = Cockpit.dynamic(dark: RGBA(0.3098, 0.5255, 0.9098, 1), light: RGBA(0.1843, 0.4196, 0.8392, 1), darkHC: RGBA(0.349, 0.5686, 0.9569, 1), lightHC: RGBA(0.098, 0.3333, 0.7451, 1))
    public static let storage2 = Cockpit.dynamic(dark: RGBA(0.7765, 0.3686, 0.4824, 1), light: RGBA(0.7529, 0.302, 0.4235, 1), darkHC: RGBA(0.8431, 0.4275, 0.5412, 1), lightHC: RGBA(0.6588, 0.2157, 0.3451, 1))
    public static let storage3 = Cockpit.dynamic(dark: RGBA(0.5216, 0.4431, 0.8627, 1), light: RGBA(0.4196, 0.3333, 0.8196, 1), darkHC: RGBA(0.5765, 0.502, 0.9255, 1), lightHC: RGBA(0.349, 0.2471, 0.7255, 1))
    public static let storage4 = Cockpit.dynamic(dark: RGBA(0.7098, 0.5216, 0.2275, 1), light: RGBA(0.6588, 0.4471, 0.098, 1), darkHC: RGBA(0.7294, 0.5412, 0.2471, 1), lightHC: RGBA(0.5608, 0.3725, 0.0157, 1))
    public static let storage5 = Cockpit.dynamic(dark: RGBA(0.0588, 0.6275, 0.5804, 1), light: RGBA(0, 0.5412, 0.4941, 1), darkHC: RGBA(0.1412, 0.6627, 0.6157, 1), lightHC: RGBA(0.0118, 0.5059, 0.4157, 1))
    public static let storageOther = Cockpit.dynamic(dark: RGBA(0.3804, 0.3804, 0.3804, 1), light: RGBA(0.5412, 0.5412, 0.5412, 1), darkHC: RGBA(0.5059, 0.5059, 0.5059, 1), lightHC: RGBA(0.451, 0.451, 0.451, 1))
    public static let storageOwn = Cockpit.dynamic(dark: RGBA(0.2863, 0.2863, 0.2863, 1), light: RGBA(0.7176, 0.7176, 0.7176, 1), darkHC: RGBA(0.3529, 0.3529, 0.3529, 1), lightHC: RGBA(0.6431, 0.6431, 0.6431, 1))
    public static let storageDisk = Cockpit.dynamic(dark: RGBA(0.2, 0.2, 0.2, 1), light: RGBA(0.851, 0.851, 0.851, 1), darkHC: RGBA(0.2392, 0.2392, 0.2392, 1), lightHC: RGBA(0.7922, 0.7922, 0.7922, 1))
    public static let plan = Cockpit.dynamic(dark: RGBA(0.6627, 0.5451, 1, 1), light: RGBA(0.4157, 0.2471, 0.8157, 1), darkHC: RGBA(0.7882, 0.7059, 1, 1), lightHC: RGBA(0.3059, 0.1333, 0.6824, 1))
    public static let now = Cockpit.dynamic(dark: RGBA(1, 0.4784, 0.2392, 1), light: RGBA(0.7608, 0.2549, 0.0471, 1), darkHC: RGBA(1, 0.6275, 0.4392, 1), lightHC: RGBA(0.5608, 0.1804, 0.0235, 1))
    public static let engaged = Cockpit.dynamic(dark: RGBA(0.349, 0.8902, 0.6314, 1), light: RGBA(0.0588, 0.4784, 0.2941, 1), darkHC: RGBA(0.5451, 0.9294, 0.7451, 1), lightHC: RGBA(0.0275, 0.3529, 0.2078, 1))
    public static let caution = Cockpit.dynamic(dark: RGBA(1, 0.8314, 0.3686, 1), light: RGBA(0.6039, 0.3725, 0, 1), darkHC: RGBA(1, 0.8863, 0.5647, 1), lightHC: RGBA(0.4314, 0.2667, 0, 1))
    public static let warning = Cockpit.dynamic(dark: RGBA(1, 0.3294, 0.4392, 1), light: RGBA(0.702, 0.1255, 0.2471, 1), darkHC: RGBA(1, 0.5412, 0.6078, 1), lightHC: RGBA(0.549, 0.0784, 0.1882, 1))
    public static let here = Cockpit.dynamic(dark: RGBA(1, 1, 1, 1), light: RGBA(0.1176, 0.1176, 0.1176, 1), darkHC: RGBA(1, 1, 1, 1), lightHC: RGBA(0, 0, 0, 1))
    public static let planSoft = Cockpit.dynamic(dark: RGBA(0.149, 0.1333, 0.1922, 1), light: RGBA(0.9255, 0.9059, 0.9647, 1), darkHC: RGBA(0.149, 0.1333, 0.1922, 1), lightHC: RGBA(0.9255, 0.9059, 0.9647, 1))
    public static let nowSoft = Cockpit.dynamic(dark: RGBA(0.1922, 0.1255, 0.0941, 1), light: RGBA(0.9765, 0.9294, 0.9059, 1), darkHC: RGBA(0.1922, 0.1255, 0.0941, 1), lightHC: RGBA(0.9765, 0.9294, 0.9059, 1))
    public static let engagedSoft = Cockpit.dynamic(dark: RGBA(0.1059, 0.1765, 0.1451, 1), light: RGBA(0.8941, 0.9333, 0.9176, 1), darkHC: RGBA(0.1059, 0.1765, 0.1451, 1), lightHC: RGBA(0.8941, 0.9333, 0.9176, 1))
    public static let cautionSoft = Cockpit.dynamic(dark: RGBA(0.1922, 0.1686, 0.1098, 1), light: RGBA(0.9529, 0.9333, 0.8941, 1), darkHC: RGBA(0.1922, 0.1686, 0.1098, 1), lightHC: RGBA(0.9529, 0.9333, 0.8941, 1))
    public static let warningSoft = Cockpit.dynamic(dark: RGBA(0.1922, 0.1059, 0.1176, 1), light: RGBA(0.9529, 0.8941, 0.9059, 1), darkHC: RGBA(0.1922, 0.1059, 0.1176, 1), lightHC: RGBA(0.9529, 0.8941, 0.9059, 1))
    public static let hereSoft = Cockpit.dynamic(dark: RGBA(0.1686, 0.1686, 0.1686, 1), light: RGBA(0.8824, 0.8824, 0.8824, 1), darkHC: RGBA(0.1686, 0.1686, 0.1686, 1), lightHC: RGBA(0.8824, 0.8824, 0.8824, 1))
    public static let onSignal = Cockpit.dynamic(dark: RGBA(0.0588, 0.0588, 0.0588, 1), light: RGBA(1, 1, 1, 1), darkHC: RGBA(0.0588, 0.0588, 0.0588, 1), lightHC: RGBA(1, 1, 1, 1))
    public static let thumb = Cockpit.dynamic(dark: RGBA(0.1961, 0.1961, 0.1961, 1), light: RGBA(1, 1, 1, 1), darkHC: RGBA(0.3451, 0.3451, 0.3451, 1), lightHC: RGBA(1, 1, 1, 1))
    public static let knob = Cockpit.dynamic(dark: RGBA(1, 1, 1, 1), light: RGBA(1, 1, 1, 1), darkHC: RGBA(1, 1, 1, 1), lightHC: RGBA(1, 1, 1, 1))
    public static let photoScrim = Cockpit.dynamic(dark: RGBA(0, 0, 0, 0.5), light: RGBA(0, 0, 0, 0.5), darkHC: RGBA(0, 0, 0, 0.5), lightHC: RGBA(0, 0, 0, 0.5))
    public static let focus = Cockpit.dynamic(dark: RGBA(1, 1, 1, 0.4), light: RGBA(0.1176, 0.1176, 0.1176, 0.35), darkHC: RGBA(1, 1, 1, 1), lightHC: RGBA(0, 0, 0, 1))
    public static let selection = Cockpit.dynamic(dark: RGBA(1, 1, 1, 0.075), light: RGBA(0.1176, 0.1176, 0.1176, 0.055), darkHC: RGBA(1, 1, 1, 0.18), lightHC: RGBA(0, 0, 0, 0.12))
    public static let hover = Cockpit.dynamic(dark: RGBA(1, 1, 1, 0.04), light: RGBA(0.1176, 0.1176, 0.1176, 0.035), darkHC: RGBA(1, 1, 1, 0.1), lightHC: RGBA(0, 0, 0, 0.07))
    public static let pressed = Cockpit.dynamic(dark: RGBA(1, 1, 1, 0.12), light: RGBA(0.1176, 0.1176, 0.1176, 0.08), darkHC: RGBA(1, 1, 1, 0.24), lightHC: RGBA(0, 0, 0, 0.16))
    public static let nest = Cockpit.dynamic(dark: RGBA(1, 1, 1, 0.03), light: RGBA(0.1176, 0.1176, 0.1176, 0.03), darkHC: RGBA(1, 1, 1, 0.06), lightHC: RGBA(0, 0, 0, 0.06))
    public static let code = Cockpit.dynamic(dark: RGBA(0.0627, 0.0627, 0.0627, 1), light: RGBA(0.0627, 0.0627, 0.0627, 1), darkHC: RGBA(0, 0, 0, 1), lightHC: RGBA(0, 0, 0, 1))
    public static let codeGround = Cockpit.dynamic(dark: RGBA(0.949, 0.949, 0.949, 1), light: RGBA(1, 1, 1, 1), darkHC: RGBA(1, 1, 1, 1), lightHC: RGBA(1, 1, 1, 1))
    public static let accentSolid = Cockpit.dynamic(dark: RGBA(1, 1, 1, 1), light: RGBA(0.1176, 0.1176, 0.1176, 1), darkHC: RGBA(1, 1, 1, 1), lightHC: RGBA(0, 0, 0, 1))
    public static let accentInk = Cockpit.dynamic(dark: RGBA(0.0588, 0.0588, 0.0588, 1), light: RGBA(1, 1, 1, 1), darkHC: RGBA(0.0588, 0.0588, 0.0588, 1), lightHC: RGBA(1, 1, 1, 1))
    public static let mapLand = Cockpit.dynamic(dark: RGBA(0.1216, 0.1216, 0.1216, 1), light: RGBA(0.9412, 0.9412, 0.9412, 1), darkHC: RGBA(0.1216, 0.1216, 0.1216, 1), lightHC: RGBA(0.9412, 0.9412, 0.9412, 1))
    public static let mapRoadMinor = Cockpit.dynamic(dark: RGBA(0.1569, 0.1569, 0.1569, 1), light: RGBA(1, 1, 1, 1), darkHC: RGBA(0.1569, 0.1569, 0.1569, 1), lightHC: RGBA(1, 1, 1, 1))
    public static let mapRoadMajor = Cockpit.dynamic(dark: RGBA(0.2, 0.2, 0.2, 1), light: RGBA(1, 1, 1, 1), darkHC: RGBA(0.2, 0.2, 0.2, 1), lightHC: RGBA(1, 1, 1, 1))
    public static let mapDim = Cockpit.dynamic(dark: RGBA(0.7961, 0.7961, 0.7961, 1), light: RGBA(0.9804, 0.9804, 0.9804, 1), darkHC: RGBA(0.7961, 0.7961, 0.7961, 1), lightHC: RGBA(0.9804, 0.9804, 0.9804, 1))
  }

  enum Style {
    public static let iosDisplay = TextStyle(size: 34, lineHeight: 41, weight: 600, design: .default, textStyle: .largeTitle, tracking: -0.408, italic: false, tabular: false, uppercase: false)
    public static let iosTitle1 = TextStyle(size: 28, lineHeight: 34, weight: 600, design: .default, textStyle: .title, tracking: -0.28, italic: false, tabular: false, uppercase: false)
    public static let iosTitle2 = TextStyle(size: 22, lineHeight: 28, weight: 500, design: .default, textStyle: .title2, tracking: -0.132, italic: false, tabular: false, uppercase: false)
    public static let iosGreeting = TextStyle(size: 22, lineHeight: 28, weight: 400, design: .default, textStyle: .title2, tracking: -0.264, italic: false, tabular: false, uppercase: false)
    public static let iosHeadline = TextStyle(size: 17, lineHeight: 22, weight: 600, design: .default, textStyle: .body, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let iosBody = TextStyle(size: 17, lineHeight: 22, weight: 400, design: .default, textStyle: .body, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let iosReading = TextStyle(size: 17, lineHeight: 25, weight: 400, design: .default, textStyle: .body, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let iosRowTitle = TextStyle(size: 15, lineHeight: 20, weight: 500, design: .default, textStyle: .subheadline, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let iosSubhead = TextStyle(size: 15, lineHeight: 20, weight: 400, design: .default, textStyle: .subheadline, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let iosFootnote = TextStyle(size: 13, lineHeight: 18, weight: 400, design: .default, textStyle: .footnote, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let iosCaption = TextStyle(size: 12, lineHeight: 16, weight: 400, design: .default, textStyle: .caption, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let iosLabel = TextStyle(size: 12, lineHeight: 16, weight: 600, design: .default, textStyle: .caption, tracking: 0.072, italic: false, tabular: false, uppercase: false)
    public static let iosCaption2 = TextStyle(size: 11, lineHeight: 13, weight: 500, design: .default, textStyle: .caption2, tracking: 0.066, italic: false, tabular: false, uppercase: false)
    public static let iosFigureXl = TextStyle(size: 34, lineHeight: 41, weight: 600, design: .default, textStyle: .largeTitle, tracking: -0.408, italic: false, tabular: true, uppercase: false)
    public static let iosFigureL = TextStyle(size: 22, lineHeight: 28, weight: 600, design: .default, textStyle: .title2, tracking: -0.132, italic: false, tabular: true, uppercase: false)
    public static let iosFigureM = TextStyle(size: 17, lineHeight: 22, weight: 600, design: .default, textStyle: .body, tracking: 0, italic: false, tabular: true, uppercase: false)
    public static let iosMonoLabel = TextStyle(size: 11, lineHeight: 14, weight: 500, design: .monospaced, textStyle: .caption2, tracking: 0.88, italic: false, tabular: false, uppercase: true)
    public static let iosVoice = TextStyle(size: 15, lineHeight: 20, weight: 400, design: .serif, textStyle: .subheadline, tracking: 0, italic: true, tabular: false, uppercase: false)
    public static let iosVoiceL = TextStyle(size: 20, lineHeight: 26, weight: 400, design: .serif, textStyle: .title3, tracking: 0, italic: true, tabular: false, uppercase: false)
    public static let macDisplay = TextStyle(size: 28, lineHeight: 34, weight: 600, design: .default, textStyle: nil, tracking: -0.7, italic: false, tabular: false, uppercase: false)
    public static let macGreeting = TextStyle(size: 28, lineHeight: 34, weight: 400, design: .default, textStyle: nil, tracking: -0.56, italic: false, tabular: false, uppercase: false)
    public static let macTitle1 = TextStyle(size: 22, lineHeight: 28, weight: 600, design: .default, textStyle: nil, tracking: -0.176, italic: false, tabular: false, uppercase: false)
    public static let macHeading = TextStyle(size: 20, lineHeight: 26, weight: 600, design: .default, textStyle: nil, tracking: -0.2, italic: false, tabular: false, uppercase: false)
    public static let macTitle2 = TextStyle(size: 17, lineHeight: 22, weight: 600, design: .default, textStyle: nil, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let macHeadline = TextStyle(size: 13, lineHeight: 18, weight: 500, design: .default, textStyle: nil, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let macBody = TextStyle(size: 13, lineHeight: 18, weight: 400, design: .default, textStyle: nil, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let macReading = TextStyle(size: 15, lineHeight: 23, weight: 400, design: .default, textStyle: nil, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let macSubhead = TextStyle(size: 12, lineHeight: 16, weight: 400, design: .default, textStyle: nil, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let macLabel = TextStyle(size: 11, lineHeight: 14, weight: 600, design: .default, textStyle: nil, tracking: 0.066, italic: false, tabular: false, uppercase: false)
    public static let macFootnote = TextStyle(size: 11, lineHeight: 14, weight: 400, design: .default, textStyle: nil, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let macFigureL = TextStyle(size: 22, lineHeight: 28, weight: 600, design: .default, textStyle: nil, tracking: -0.132, italic: false, tabular: true, uppercase: false)
    public static let macFigureM = TextStyle(size: 15, lineHeight: 20, weight: 600, design: .default, textStyle: nil, tracking: 0, italic: false, tabular: true, uppercase: false)
    public static let macMonoTime = TextStyle(size: 12, lineHeight: 18, weight: 400, design: .default, textStyle: nil, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let macMonoLabel = TextStyle(size: 12, lineHeight: 18, weight: 600, design: .default, textStyle: nil, tracking: 0, italic: false, tabular: false, uppercase: true)
    public static let macMonoData = TextStyle(size: 12, lineHeight: 18, weight: 400, design: .default, textStyle: nil, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let macVoice = TextStyle(size: 13, lineHeight: 18, weight: 400, design: .default, textStyle: nil, tracking: 0, italic: false, tabular: false, uppercase: false)
    public static let macVoiceL = TextStyle(size: 17, lineHeight: 22, weight: 400, design: .default, textStyle: nil, tracking: 0, italic: false, tabular: false, uppercase: false)
  }

  enum Space {
    public static let px: CGFloat = 1
    public static let s1: CGFloat = 4
    public static let s2: CGFloat = 8
    public static let s3: CGFloat = 12
    public static let s4: CGFloat = 16
    public static let s5: CGFloat = 20
    public static let s6: CGFloat = 24
    public static let s8: CGFloat = 32
    public static let s10: CGFloat = 40
    public static let s12: CGFloat = 48
    public static let s16: CGFloat = 64
  }

  enum Radius {
    public static let s2xs: CGFloat = 1
    public static let xs: CGFloat = 4
    public static let control: CGFloat = 8
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 12
    public static let bubble: CGFloat = 20
    public static let s2xl: CGFloat = 22
    public static let picture: CGFloat = 18
    public static let composer: CGFloat = 26
    public static let full: CGFloat = 999
  }

  enum Size {
    public static let target: CGFloat = 44
    public static let controlLg: CGFloat = 50
    public static let controlMd: CGFloat = 44
    public static let controlSm: CGFloat = 32
    public static let controlMac: CGFloat = 32
    public static let actionMac: CGFloat = 112
    public static let onboardingColumn: CGFloat = 540
    public static let row: CGFloat = 44
    public static let rowMac: CGFloat = 32
    public static let rowMacTall: CGFloat = 60
    public static let rowNavMac: CGFloat = 30
    public static let lead: CGFloat = 40
    public static let formLabel: CGFloat = 96
    public static let iconXs: CGFloat = 12
    public static let iconSm: CGFloat = 16
    public static let iconMd: CGFloat = 20
    public static let iconLg: CGFloat = 24
    public static let iconXl: CGFloat = 32
    public static let capsule: CGFloat = 28
    public static let capsuleMac: CGFloat = 22
    public static let moment: CGFloat = 24
    public static let loading: CGFloat = 20
    public static let reading: CGFloat = 720
    public static let main: CGFloat = 960
    public static let frame: CGFloat = 1360
    public static let onboardingWidth: CGFloat = 760
    public static let onboardingHeight: CGFloat = 752
    public static let composer: CGFloat = 44
    public static let composerControl: CGFloat = 36
    public static let thumb: CGFloat = 64
    public static let questionPicture: CGFloat = 200
    public static let voiceNote: CGFloat = 270
    public static let drawer: CGFloat = 318
    public static let citation: CGFloat = 20
    public static let code: CGFloat = 168
    public static let avatarSm: CGFloat = 24
    public static let avatarChip: CGFloat = 28
    public static let avatarMd: CGFloat = 32
    public static let avatarRow: CGFloat = 36
    public static let avatarPortrait: CGFloat = 52
    public static let portraitName: CGFloat = 72
    public static let avatarTile: CGFloat = 56
    public static let avatarHead: CGFloat = 72
  }

  enum Stroke {
    public static let hairline: CGFloat = 0.5
    public static let border: CGFloat = 1
    public static let line: CGFloat = 2
    public static let focus: CGFloat = 1
    public static let focusOffset: CGFloat = 1
  }

  enum Opacity {
    public static let disabled: CGFloat = 0.38
    public static let pressed: CGFloat = 0.8
    public static let pastPlan: CGFloat = 0.5
  }

  enum Duration {
    public static let instant: Double = 0.1
    public static let fast: Double = 0.15
    public static let fold: Double = 0.18
    public static let open: Double = 0.22
    public static let base: Double = 0.24
    public static let settle: Double = 0.12
    public static let slow: Double = 0.36
    public static let draw: Double = 0.6
    public static let stagger: Double = 0.03
    public static let breath: Double = 2.8
    public static let grace: Double = 0.4
    public static let patience: Double = 3
    public static let dwell: Double = 0.65
    public static let quiet: Double = 0.9
    public static let decrypt: Double = 0.62
    public static let decryptStagger: Double = 0.05
    public static let sweep: Double = 2.2
    public static let word: Double = 0.014
  }

  enum Dash {
    public static let plan: [CGFloat] = [4, 4]
    public static let future: [CGFloat] = [2, 4]
  }

  enum Ease {
    public static func out(_ duration: Double) -> Animation { .timingCurve(0.2, 0, 0, 1, duration: duration) }
    public static func inOut(_ duration: Double) -> Animation { .timingCurve(0.45, 0, 0.25, 1, duration: duration) }
    public static func spring() -> Animation { .spring(response: 0.3, dampingFraction: 0.85) }
  }

  enum Shadow {
    public static let edge = ShadowSet(dark: [.init(color: RGBA(1, 1, 1, 0.05), x: 0, y: 0, blur: 0, spread: 1, inset: true)], light: [.init(color: RGBA(0.1176, 0.1176, 0.1176, 0.04), x: 0, y: 1, blur: 2, spread: 0, inset: false), .init(color: RGBA(0.1176, 0.1176, 0.1176, 0.05), x: 0, y: 0, blur: 0, spread: 1, inset: true)], darkHC: [.init(color: RGBA(1, 1, 1, 0.22), x: 0, y: 0, blur: 0, spread: 1, inset: true)], lightHC: [.init(color: RGBA(0, 0, 0, 0.32), x: 0, y: 0, blur: 0, spread: 1, inset: true)])
    public static let panel = ShadowSet(dark: [.init(color: RGBA(1, 1, 1, 0.06), x: 0, y: 0, blur: 0, spread: 1, inset: true), .init(color: RGBA(0, 0, 0, 0.3), x: 0, y: 16, blur: 40, spread: 0, inset: false)], light: [.init(color: RGBA(0.1176, 0.1176, 0.1176, 0.05), x: 0, y: 0, blur: 0, spread: 1, inset: false), .init(color: RGBA(0.1176, 0.1176, 0.1176, 0.04), x: 0, y: 1, blur: 2, spread: 0, inset: false), .init(color: RGBA(0.1176, 0.1176, 0.1176, 0.07), x: 0, y: 16, blur: 40, spread: 0, inset: false)], darkHC: [.init(color: RGBA(1, 1, 1, 0.22), x: 0, y: 0, blur: 0, spread: 1, inset: true)], lightHC: [.init(color: RGBA(0, 0, 0, 0.32), x: 0, y: 0, blur: 0, spread: 1, inset: true)])
    public static let sheet = ShadowSet(dark: [.init(color: RGBA(1, 1, 1, 0.06), x: 0, y: 0, blur: 0, spread: 1, inset: true), .init(color: RGBA(0, 0, 0, 0.35), x: 0, y: 12, blur: 24, spread: 0, inset: false)], light: [.init(color: RGBA(0.1176, 0.1176, 0.1176, 0.06), x: 0, y: 0, blur: 0, spread: 1, inset: false), .init(color: RGBA(0.1176, 0.1176, 0.1176, 0.2), x: 0, y: 12, blur: 24, spread: 0, inset: false)], darkHC: [.init(color: RGBA(1, 1, 1, 0.3), x: 0, y: 0, blur: 0, spread: 1, inset: false), .init(color: RGBA(0, 0, 0, 0.6), x: 0, y: 12, blur: 24, spread: 0, inset: false)], lightHC: [.init(color: RGBA(0, 0, 0, 0.5), x: 0, y: 0, blur: 0, spread: 1, inset: false), .init(color: RGBA(0, 0, 0, 0.2), x: 0, y: 12, blur: 24, spread: 0, inset: false)])
    public static let raised = ShadowSet(dark: [.init(color: RGBA(1, 1, 1, 0.07), x: 0, y: 0, blur: 0, spread: 1, inset: true), .init(color: RGBA(0, 0, 0, 0.32), x: 0, y: 8, blur: 24, spread: 0, inset: false)], light: [.init(color: RGBA(0.1176, 0.1176, 0.1176, 0.12), x: 0, y: 0, blur: 0, spread: 0.5, inset: false), .init(color: RGBA(0.1176, 0.1176, 0.1176, 0.1), x: 0, y: 8, blur: 24, spread: 0, inset: false)], darkHC: [.init(color: RGBA(1, 1, 1, 0.3), x: 0, y: 0, blur: 0, spread: 1, inset: false), .init(color: RGBA(0, 0, 0, 0.6), x: 0, y: 10, blur: 30, spread: 0, inset: false)], lightHC: [.init(color: RGBA(0, 0, 0, 0.5), x: 0, y: 0, blur: 0, spread: 1, inset: false), .init(color: RGBA(0, 0, 0, 0.2), x: 0, y: 10, blur: 30, spread: 0, inset: false)])
    public static let glass = ShadowSet(dark: [.init(color: RGBA(1, 1, 1, 0.22), x: 0, y: 0.5, blur: 0, spread: 0, inset: true), .init(color: RGBA(1, 1, 1, 0.08), x: 0, y: 0, blur: 0, spread: 0.5, inset: true), .init(color: RGBA(0, 0, 0, 0.7), x: 0, y: 0, blur: 0, spread: 0.5, inset: false), .init(color: RGBA(0, 0, 0, 0.45), x: 0, y: 10, blur: 30, spread: 0, inset: false)], light: [.init(color: RGBA(1, 1, 1, 0.9), x: 0, y: 0.5, blur: 0, spread: 0, inset: true), .init(color: RGBA(0.1176, 0.1176, 0.1176, 0.07), x: 0, y: 0, blur: 0, spread: 0.5, inset: true), .init(color: RGBA(0.1176, 0.1176, 0.1176, 0.16), x: 0, y: 0, blur: 0, spread: 0.5, inset: false), .init(color: RGBA(0.1176, 0.1176, 0.1176, 0.12), x: 0, y: 10, blur: 30, spread: 0, inset: false)], darkHC: [.init(color: RGBA(1, 1, 1, 0.4), x: 0, y: 0.5, blur: 0, spread: 0, inset: true), .init(color: RGBA(1, 1, 1, 0.24), x: 0, y: 0, blur: 0, spread: 1, inset: true), .init(color: RGBA(0, 0, 0, 0.6), x: 0, y: 10, blur: 30, spread: 0, inset: false)], lightHC: [.init(color: RGBA(1, 1, 1, 1), x: 0, y: 0.5, blur: 0, spread: 0, inset: true), .init(color: RGBA(0, 0, 0, 0.3), x: 0, y: 0, blur: 0, spread: 1, inset: true), .init(color: RGBA(0, 0, 0, 0.2), x: 0, y: 10, blur: 30, spread: 0, inset: false)])
    public static let knob = ShadowSet(dark: [.init(color: RGBA(0, 0, 0, 0.3), x: 0, y: 3, blur: 8, spread: 0, inset: false), .init(color: RGBA(0, 0, 0, 0.12), x: 0, y: 0, blur: 0, spread: 0.5, inset: false)], light: [.init(color: RGBA(0.1176, 0.1176, 0.1176, 0.15), x: 0, y: 3, blur: 8, spread: 0, inset: false), .init(color: RGBA(0.1176, 0.1176, 0.1176, 0.06), x: 0, y: 0, blur: 0, spread: 0.5, inset: false)], darkHC: [.init(color: RGBA(0, 0, 0, 0.4), x: 0, y: 3, blur: 8, spread: 0, inset: false), .init(color: RGBA(0, 0, 0, 0.5), x: 0, y: 0, blur: 0, spread: 1, inset: false)], lightHC: [.init(color: RGBA(0, 0, 0, 0.2), x: 0, y: 3, blur: 8, spread: 0, inset: false), .init(color: RGBA(0, 0, 0, 0.4), x: 0, y: 0, blur: 0, spread: 1, inset: false)])
    public static let float = ShadowSet(dark: [.init(color: RGBA(0, 0, 0, 0.8), x: 0, y: 0, blur: 0, spread: 0.5, inset: false), .init(color: RGBA(0, 0, 0, 0.6), x: 0, y: 24, blur: 64, spread: 0, inset: false)], light: [.init(color: RGBA(0.1176, 0.1176, 0.1176, 0.16), x: 0, y: 0, blur: 0, spread: 0.5, inset: false), .init(color: RGBA(0.1176, 0.1176, 0.1176, 0.18), x: 0, y: 24, blur: 64, spread: 0, inset: false)], darkHC: [.init(color: RGBA(1, 1, 1, 0.3), x: 0, y: 0, blur: 0, spread: 1, inset: false), .init(color: RGBA(0, 0, 0, 0.7), x: 0, y: 24, blur: 64, spread: 0, inset: false)], lightHC: [.init(color: RGBA(0, 0, 0, 0.5), x: 0, y: 0, blur: 0, spread: 1, inset: false), .init(color: RGBA(0, 0, 0, 0.25), x: 0, y: 24, blur: 64, spread: 0, inset: false)])
  }

  enum Onboarding {
    public enum Color {
      public static let ground = Cockpit.dynamic(dark: RGBA(0.0471, 0.0706, 0.0824, 1), light: RGBA(0.0471, 0.0706, 0.0824, 1), darkHC: RGBA(0.0471, 0.0706, 0.0824, 1), lightHC: RGBA(0.0471, 0.0706, 0.0824, 1))
      public static let ink = Cockpit.dynamic(dark: RGBA(0.9294, 0.9451, 0.949, 1), light: RGBA(0.9294, 0.9451, 0.949, 1), darkHC: RGBA(1, 1, 1, 1), lightHC: RGBA(1, 1, 1, 1))
      public static let soft = Cockpit.dynamic(dark: RGBA(0.5608, 0.6118, 0.6275, 1), light: RGBA(0.5608, 0.6118, 0.6275, 1), darkHC: RGBA(0.7059, 0.7529, 0.7686, 1), lightHC: RGBA(0.7059, 0.7529, 0.7686, 1))
      public static let line = Cockpit.dynamic(dark: RGBA(0.9294, 0.9451, 0.949, 0.11), light: RGBA(0.9294, 0.9451, 0.949, 0.11), darkHC: RGBA(0.9294, 0.9451, 0.949, 0.3), lightHC: RGBA(0.9294, 0.9451, 0.949, 0.3))
      public static let hairline = Cockpit.dynamic(dark: RGBA(0.9294, 0.9451, 0.949, 0.07), light: RGBA(0.9294, 0.9451, 0.949, 0.07), darkHC: RGBA(0.9294, 0.9451, 0.949, 0.2), lightHC: RGBA(0.9294, 0.9451, 0.949, 0.2))
      public static let panel = Cockpit.dynamic(dark: RGBA(0.9294, 0.9451, 0.949, 0.035), light: RGBA(0.9294, 0.9451, 0.949, 0.035), darkHC: RGBA(0.9294, 0.9451, 0.949, 0.035), lightHC: RGBA(0.9294, 0.9451, 0.949, 0.035))
      public static let raised = Cockpit.dynamic(dark: RGBA(0.9294, 0.9451, 0.949, 0.08), light: RGBA(0.9294, 0.9451, 0.949, 0.08), darkHC: RGBA(0.9294, 0.9451, 0.949, 0.08), lightHC: RGBA(0.9294, 0.9451, 0.949, 0.08))
      public static let glacier = Cockpit.dynamic(dark: RGBA(0.4941, 0.7373, 0.8196, 1), light: RGBA(0.4941, 0.7373, 0.8196, 1), darkHC: RGBA(0.5922, 0.8353, 0.9216, 1), lightHC: RGBA(0.5922, 0.8353, 0.9216, 1))
    }

    public enum Shadow {
      public static let glass = ShadowSet(dark: [.init(color: RGBA(0.9294, 0.9451, 0.949, 0.1), x: 0, y: 0, blur: 0, spread: 1, inset: true)], light: [.init(color: RGBA(0.9294, 0.9451, 0.949, 0.1), x: 0, y: 0, blur: 0, spread: 1, inset: true)], darkHC: [.init(color: RGBA(0.9294, 0.9451, 0.949, 0.3), x: 0, y: 0, blur: 0, spread: 1, inset: true)], lightHC: [.init(color: RGBA(0.9294, 0.9451, 0.949, 0.3), x: 0, y: 0, blur: 0, spread: 1, inset: true)])
    }
  }
}
