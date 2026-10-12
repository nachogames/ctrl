Pod::Spec.new do |s|
  s.name           = 'T3AgentNotifications'
  s.version        = '1.0.0'
  s.summary        = 'Native handling for agent alert pushes.'
  s.description    = 'Removes delivered agent alerts once the server reports their question answered.'
  s.author         = 'Ctrl'
  s.homepage       = 'https://github.com/pingdotgg/t3code'
  s.platforms      = { :ios => '18.0' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift}'
end
