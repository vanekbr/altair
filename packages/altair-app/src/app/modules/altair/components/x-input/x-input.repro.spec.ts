import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Store } from '@ngrx/store';
import { mockStoreFactory } from '../../../../../testing';
import { XInputComponent } from './x-input.component';
import { EnvironmentService } from '../../services';
import { MockService } from 'ng-mocks';
import { EditorState } from '@codemirror/state';

describe('XInputComponent paste bug', () => {
  let component: XInputComponent;
  let fixture: ComponentFixture<XInputComponent>;

  beforeEach(async () => {
    const mockStore = mockStoreFactory();
    await TestBed.configureTestingModule({
      declarations: [XInputComponent],
      providers: [
        {
          provide: EnvironmentService,
          useValue: MockService(EnvironmentService),
        },
        {
          provide: Store,
          useValue: mockStore,
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(XInputComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should only replace the selected text when pasting, not the entire document', () => {
    // Initialize the component to set up extensions
    component.setReady();
    const extensions = component.getExtensions();

    // Create initial state with a URL
    const initialText = 'https://example.com/path';
    const state = EditorState.create({
      doc: initialText,
      extensions: extensions,
    });

    // Create a transaction that pastes "new.site" over "example.com" (positions 8-18)
    // This simulates user selecting "example.com" and pasting "new.site"
    const tr = state.update({
      changes: [{ from: 8, to: 18, insert: 'new.site' }],
      userEvent: 'input.paste',
    });

    // After pasting "new.site" over "example.com", the result should be:
    // "https://new.site/path"
    // NOT just "new.site" (which is the current buggy behavior)
    expect(tr.newDoc.toString()).toBe('https://new.site/path');
  });
});
