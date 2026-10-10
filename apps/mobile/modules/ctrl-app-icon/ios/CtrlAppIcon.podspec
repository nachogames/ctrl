Pod::Spec.new do |s|
  s.name           = 'CtrlAppIcon'
  s.version        = '1.0.0'
  s.summary        = 'Alternate home screen icons for Ctrl.'
  s.description    = 'Switches between the outline, solid and mac keycap app icons.'
  s.author         = 'Ctrl'
  s.homepage       = 'https://github.com/pingdotgg/t3code'
  s.platforms      = { :ios => '18.0' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift}'
end
