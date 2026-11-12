require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'MediaQueue'
  s.version          = package['version']
  s.summary          = package['description']
  s.license          = package['license']
  s.homepage         = 'https://github.com/hermes/capacitor-media-queue'
  s.author           = { 'Hermes' => 'hermes@example.com' }
  s.source           = { :path => '.' }
  s.source_files     = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '14.0'
  s.dependency 'Capacitor'
  s.swift_version    = '5.1'
  s.frameworks       = 'AVFoundation', 'MediaPlayer'
end
